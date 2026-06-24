/**
 * Motor de scoring crediticio.
 *
 * Pipeline (inciso II del kata):
 *   1. Recolectar fuentes alternativas (buró, servicios públicos, wallets,
 *      e-commerce, recargas móviles) -> scoring.external_data_snapshots.
 *   2. Calcular score ponderado con el modelo activo (blue/green).
 *   3. Clasificar nivel de riesgo y generar recomendación.
 *   4. Generar explicación SHAP simulada.
 *   5. Persistir resultado en scoring.scoring_results.
 *   6. Registrar trazabilidad en audit.event_store.
 *
 * Es autocontenido: si no existen datos externos para la solicitud, los
 * simula en este mismo servicio en lugar de depender de que otro
 * microservicio (external-data-service) ya los haya generado.
 */

const { query } = require('../config/database');
const modelService = require('./model.service');
const shapService = require('./shap.service');
const auditService = require('./audit.service');
const { queryCreditBureau, CircuitOpenError } = require('./circuitBreaker.service');

const SCORE_MIN = 300;
const SCORE_MAX = 850;

function randomSubScore() {
  return 40 + Math.floor(Math.random() * 60); // 40-100, sesgado a positivo para demo
}

async function getApplicant(applicantId) {
  const result = await query(
    `SELECT id, document_number, monthly_income, employment_status
     FROM applicant.applicants WHERE id = $1`,
    [applicantId]
  );
  return result.rows[0] || null;
}

async function getCreditApplication(applicationId) {
  const result = await query(
    `SELECT id, applicant_id, requested_amount, term_months, status
     FROM credit.credit_applications WHERE id = $1`,
    [applicationId]
  );
  return result.rows[0] || null;
}

async function getExternalDataSnapshot(applicationId) {
  const result = await query(
    `SELECT * FROM scoring.external_data_snapshots
     WHERE application_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [applicationId]
  );
  return result.rows[0] || null;
}

/**
 * Obtiene el snapshot de datos externos existente o lo genera consultando
 * (de forma protegida por circuit breaker) el buró de crédito y simulando el
 * resto de fuentes alternativas.
 */
async function getOrCreateExternalDataSnapshot(applicationId, applicant) {
  const existing = await getExternalDataSnapshot(applicationId);
  if (existing) return existing;

  let bureauResult;
  let bureauDegraded = false;
  try {
    bureauResult = await queryCreditBureau(applicant.document_number);
    bureauDegraded = Boolean(bureauResult.fromCache || bureauResult.degraded);
  } catch (err) {
    // Tanto el circuito abierto (sin caché) como un fallo transitorio
    // individual del SOAP/mainframe (timeout, SOAP_FAULT) degradan a un
    // score neutro conservador en lugar de tumbar el pipeline: el
    // requisito no funcional exige responder en <60s en el 95% de los
    // casos, así que el scoring nunca debe depender 100% de que el buró
    // esté disponible en ese instante.
    console.warn(`[scoring] Buró de crédito no disponible (${err.message}). Usando fallback degradado.`);
    bureauResult = {
      creditBureauScore: 550,
      source: err instanceof CircuitOpenError ? 'CIRCUIT_OPEN_FALLBACK' : 'TRANSIENT_FAILURE_FALLBACK',
      latencyMs: 0,
    };
    bureauDegraded = true;
  }

  const utilityScore = randomSubScore();
  const walletScore = randomSubScore();
  const ecommerceScore = randomSubScore();
  const topupScore = randomSubScore();

  const rawData = {
    bureau: {
      source: bureauResult.source,
      latency_ms: bureauResult.latencyMs,
      cache_hit: Boolean(bureauResult.fromCache),
      degraded: bureauDegraded,
    },
    utilities: { simulated: true, score: utilityScore },
    wallet: { simulated: true, score: walletScore },
    ecommerce: { simulated: true, score: ecommerceScore },
    mobile_topups: { simulated: true, score: topupScore },
  };

  const result = await query(
    `INSERT INTO scoring.external_data_snapshots
       (application_id, credit_bureau_score, utility_payment_score, wallet_transaction_score,
        ecommerce_score, mobile_topup_score, raw_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      applicationId,
      bureauResult.creditBureauScore,
      utilityScore,
      walletScore,
      ecommerceScore,
      topupScore,
      JSON.stringify(rawData),
    ]
  );

  return result.rows[0];
}

function normalizeScore(rawWeightedScore) {
  // Rango teórico aproximado del puntaje ponderado crudo con los pesos
  // actuales: ~ [0, 100*(suma de pesos)]. Lo proyectamos a 300-850.
  const maxRaw = 100 * (0.34 + 2.0 + 1.65 + 1.2 + 1.05); // peor caso entre ambos modelos
  const clamped = Math.max(0, Math.min(rawWeightedScore, maxRaw));
  const normalized = SCORE_MIN + (clamped / maxRaw) * (SCORE_MAX - SCORE_MIN);
  return Math.round(normalized);
}

function classifyRisk(score) {
  if (score >= 700) return { riskLevel: 'LOW', recommendation: 'APPROVE' };
  if (score >= 600) return { riskLevel: 'MEDIUM', recommendation: 'MANUAL_REVIEW' };
  return { riskLevel: 'HIGH', recommendation: 'REJECT' };
}

async function evaluate({ applicationId, applicantId, requestedAmount }) {
  const startedAt = Date.now();

  const application = await getCreditApplication(applicationId);
  const applicant = await getApplicant(applicantId);

  if (!applicant) {
    throw new ValidationError('applicantId no corresponde a ningún solicitante registrado');
  }

  const effectiveAmount = requestedAmount ?? application?.requested_amount ?? null;

  await auditService.recordEvent({
    aggregateId: applicationId,
    aggregateType: 'CreditApplication',
    eventType: 'ScoringStarted',
    eventData: { applicantId, requestedAmount: effectiveAmount },
    metadata: { source: 'scoring-service' },
  });

  const snapshot = await getOrCreateExternalDataSnapshot(applicationId, applicant);

  const features = {
    credit_bureau_score: snapshot.credit_bureau_score,
    utility_payment_score: snapshot.utility_payment_score,
    wallet_transaction_score: snapshot.wallet_transaction_score,
    ecommerce_score: snapshot.ecommerce_score,
    mobile_topup_score: snapshot.mobile_topup_score,
  };

  const modelConfig = modelService.getActiveModelConfig();
  const weights = modelConfig.weights;

  const rawWeightedScore =
    features.credit_bureau_score * weights.credit_bureau_score +
    features.utility_payment_score * weights.utility_payment_score +
    features.wallet_transaction_score * weights.wallet_transaction_score +
    features.ecommerce_score * weights.ecommerce_score +
    features.mobile_topup_score * weights.mobile_topup_score;

  const score = normalizeScore(rawWeightedScore);
  const { riskLevel, recommendation } = classifyRisk(score);
  const shapValues = shapService.computeShapValues(features, weights);

  const processingTimeMs = Date.now() - startedAt;

  const insertResult = await query(
    `INSERT INTO scoring.scoring_results
       (application_id, applicant_id, score, risk_level, recommendation,
        model_version, shap_values, processing_time_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      applicationId,
      applicantId,
      score,
      riskLevel,
      recommendation,
      modelConfig.version,
      JSON.stringify(shapValues),
      processingTimeMs,
    ]
  );

  const scoringResult = insertResult.rows[0];

  await auditService.recordEvent({
    aggregateId: applicationId,
    aggregateType: 'CreditApplication',
    eventType: 'ScoringCompleted',
    eventData: {
      score,
      riskLevel,
      recommendation,
      modelVersion: modelConfig.version,
      processingTimeMs,
    },
    metadata: { source: 'scoring-service', scoringResultId: scoringResult.id },
  });

  return {
    applicationId,
    applicantId,
    score,
    riskLevel,
    recommendation,
    modelVersion: modelConfig.version,
    processingTimeMs,
    shapValues,
    features,
    weights,
    requestedAmount: effectiveAmount,
    scoringResultId: scoringResult.id,
  };
}

async function getLatestResult(applicationId) {
  const result = await query(
    `SELECT * FROM scoring.scoring_results
     WHERE application_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [applicationId]
  );
  return result.rows[0] || null;
}

async function getExplanation(applicationId) {
  const result = await getLatestResult(applicationId);
  if (!result) return null;
  const shapValues = result.shap_values;
  return shapService.buildExplanation(result.score, result.risk_level, shapValues);
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

module.exports = {
  evaluate,
  getLatestResult,
  getExplanation,
  getCreditApplication,
  getApplicant,
  ValidationError,
};
