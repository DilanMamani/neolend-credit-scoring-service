/**
 * Auditoría regulatoria + Event Sourcing.
 *
 * Cada decisión de scoring/aprobación queda registrada como un evento
 * inmutable en audit.event_store, encadenado por hash (estilo blockchain
 * ligero) y firmado digitalmente con HMAC-SHA256. Esto satisface el inciso
 * b) del contexto adicional: trazabilidad completa auditable por la
 * Superintendencia, con variables de entrada, pesos del modelo y decisión
 * final, firmadas por el sistema.
 */

const crypto = require('crypto');
const { query } = require('../config/database');

const SIGNATURE_SECRET = process.env.DIGITAL_SIGNATURE_SECRET || 'neolend-default-secret';
const AUDIT_ENABLED = String(process.env.AUDIT_ENABLED || 'true') === 'true';

function sha256(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function sign(payload) {
  return crypto.createHmac('sha256', SIGNATURE_SECRET).update(payload).digest('hex');
}

async function getLastEventHash(aggregateId) {
  const result = await query(
    `SELECT hash FROM audit.event_store
     WHERE aggregate_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [aggregateId]
  );
  return result.rows[0]?.hash || null;
}

/**
 * Registra un evento inmutable en el event store, encadenado al evento
 * anterior del mismo aggregate y firmado digitalmente.
 */
async function recordEvent({ aggregateId, aggregateType, eventType, eventData, metadata = {} }) {
  if (!AUDIT_ENABLED) return null;

  const previousHash = await getLastEventHash(aggregateId);
  const canonicalPayload = JSON.stringify({ aggregateId, eventType, eventData, previousHash });
  const hash = sha256(canonicalPayload);
  const digitalSignature = sign(hash);

  const result = await query(
    `INSERT INTO audit.event_store
       (aggregate_id, aggregate_type, event_type, event_version, event_data, metadata, hash, previous_hash, digital_signature)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [
      aggregateId,
      aggregateType,
      eventType,
      JSON.stringify(eventData),
      JSON.stringify({ ...metadata, signedBy: 'neolend-credit-scoring-service' }),
      hash,
      previousHash,
      digitalSignature,
    ]
  );

  return { id: result.rows[0].id, hash, previousHash, digitalSignature, createdAt: result.rows[0].created_at };
}

/**
 * Registra la decisión de crédito completa con trazabilidad regulatoria:
 * variables de entrada, pesos del modelo, SHAP values y firma digital.
 */
async function recordCreditDecisionAudit({
  applicationId,
  applicantId,
  scoringResultId,
  inputVariables,
  modelWeights,
  shapValues,
  finalScore,
  finalDecision,
  decisionReason,
  modelVersion,
  signedBySystem,
}) {
  if (!AUDIT_ENABLED) return null;

  const canonicalPayload = JSON.stringify({
    applicationId,
    finalScore,
    finalDecision,
    modelVersion,
    inputVariables,
  });
  const digitalSignature = sign(sha256(canonicalPayload));

  const result = await query(
    `INSERT INTO audit.credit_decision_audit
       (application_id, applicant_id, scoring_result_id, input_variables, model_weights,
        shap_values, final_score, final_decision, decision_reason, model_version,
        signed_by_system, digital_signature)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, created_at`,
    [
      applicationId,
      applicantId,
      scoringResultId,
      JSON.stringify(inputVariables),
      JSON.stringify(modelWeights),
      JSON.stringify(shapValues),
      finalScore,
      finalDecision,
      decisionReason,
      modelVersion,
      signedBySystem || 'neolend-credit-scoring-service',
      digitalSignature,
    ]
  );

  return { id: result.rows[0].id, digitalSignature, createdAt: result.rows[0].created_at };
}

async function getEventStream(aggregateId) {
  const result = await query(
    `SELECT id, aggregate_id, aggregate_type, event_type, event_version, event_data,
            metadata, hash, previous_hash, digital_signature, created_at
     FROM audit.event_store
     WHERE aggregate_id = $1
     ORDER BY created_at ASC`,
    [aggregateId]
  );
  return result.rows;
}

async function getCreditDecisionAudit(applicationId) {
  const result = await query(
    `SELECT * FROM audit.credit_decision_audit
     WHERE application_id = $1
     ORDER BY created_at DESC`,
    [applicationId]
  );
  return result.rows;
}

/**
 * Recupera el event_data más reciente de un tipo de evento para un aggregate.
 * Se usa como fallback cuando la solicitud de crédito no existe todavía como
 * fila en credit.credit_applications (escenarios de prueba autocontenidos).
 */
async function getLatestEventData(aggregateId, eventType) {
  const result = await query(
    `SELECT event_data FROM audit.event_store
     WHERE aggregate_id = $1 AND event_type = $2
     ORDER BY created_at DESC LIMIT 1`,
    [aggregateId, eventType]
  );
  return result.rows[0]?.event_data || null;
}

module.exports = {
  recordEvent,
  recordCreditDecisionAudit,
  getEventStream,
  getCreditDecisionAudit,
  getLatestEventData,
  sha256,
  sign,
};
