/**
 * Motor de aprobación (inciso III del kata).
 *
 * Reglas de negocio:
 *   - requested_amount <= AUTO_APPROVAL_LIMIT y score >= MIN_SCORE_APPROVAL  -> APPROVED (AUTOMATIC)
 *   - requested_amount >  AUTO_APPROVAL_LIMIT y score >= MIN_SCORE_MANUAL_REVIEW -> MANUAL_REVIEW (escalado)
 *   - score < MIN_SCORE_MANUAL_REVIEW -> REJECTED (AUTOMATIC)
 *   - datos incompletos (sin scoring o sin monto) -> MANUAL_REVIEW
 *
 * Toda decisión queda firmada digitalmente en audit.credit_decision_audit y
 * encadenada como evento inmutable en audit.event_store.
 */

const { query } = require('../config/database');
const scoringService = require('./scoring.service');
const auditService = require('./audit.service');

const AUTO_APPROVAL_LIMIT = Number(process.env.AUTO_APPROVAL_LIMIT || 500);
const MIN_SCORE_APPROVAL = Number(process.env.MIN_SCORE_APPROVAL || 700);
const MIN_SCORE_MANUAL_REVIEW = Number(process.env.MIN_SCORE_MANUAL_REVIEW || 600);

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

async function updateApplicationStatus(applicationId, status) {
  try {
    await query(
      `UPDATE credit.credit_applications SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, applicationId]
    );
  } catch (err) {
    // No bloquea el flujo de aprobación si la tabla de solicitudes (otro
    // bounded context) no tiene la fila todavía.
    console.warn(`[approval] No se pudo actualizar credit_applications.status: ${err.message}`);
  }
}

async function insertApprovalDecision({ applicationId, scoringResultId, decision, decisionType, reason, decidedBy }) {
  const result = await query(
    `INSERT INTO scoring.approval_decisions
       (application_id, scoring_result_id, decision, decision_type, reason, decided_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [applicationId, scoringResultId, decision, decisionType, reason, decidedBy || null]
  );
  return result.rows[0];
}

/**
 * Aprobación / rechazo automático en base al último resultado de scoring.
 *
 * El monto solicitado se busca en este orden:
 *   1. requestedAmountOverride explícito en la petición.
 *   2. credit.credit_applications.requested_amount (flujo normal, cuando
 *      credit-application-service ya creó la solicitud).
 *   3. El monto registrado en el evento ScoringStarted (fallback para poder
 *      probar este servicio de forma autocontenida, sin depender de que la
 *      fila de credit_applications exista).
 */
async function runAutomaticApproval(applicationId, requestedAmountOverride) {
  const scoringResult = await scoringService.getLatestResult(applicationId);
  const application = await scoringService.getCreditApplication(applicationId);

  // Si falta el monto o el applicant_id (porque credit_applications todavía
  // no tiene la fila), recurrimos al evento ScoringStarted que el propio
  // scoring-service registró al iniciar el pipeline.
  const needsFallback = requestedAmountOverride === undefined && !application;
  const scoringStartedData = needsFallback
    ? await auditService.getLatestEventData(applicationId, 'ScoringStarted')
    : null;

  let requestedAmount = Number(requestedAmountOverride ?? application?.requested_amount);
  if (Number.isNaN(requestedAmount)) {
    requestedAmount = Number(scoringStartedData?.requestedAmount);
  }

  // applicant_id es NOT NULL en audit.credit_decision_audit.
  const applicantId = scoringResult?.applicant_id || application?.applicant_id || scoringStartedData?.applicantId || null;

  const score = scoringResult?.score;

  let decision;
  let reason;

  if (!scoringResult || Number.isNaN(requestedAmount)) {
    decision = 'MANUAL_REVIEW';
    reason = 'Datos incompletos: falta resultado de scoring o monto solicitado.';
  } else if (requestedAmount <= AUTO_APPROVAL_LIMIT && score >= MIN_SCORE_APPROVAL) {
    decision = 'APPROVED';
    reason = `Monto solicitado (USD ${requestedAmount}) <= USD ${AUTO_APPROVAL_LIMIT} y score ${score} de bajo riesgo.`;
  } else if (requestedAmount > AUTO_APPROVAL_LIMIT && score >= MIN_SCORE_MANUAL_REVIEW) {
    decision = 'MANUAL_REVIEW';
    reason = `Monto solicitado (USD ${requestedAmount}) supera USD ${AUTO_APPROVAL_LIMIT}; requiere revisión manual con evidencia precargada.`;
  } else if (score < MIN_SCORE_MANUAL_REVIEW) {
    decision = 'REJECTED';
    reason = `Score ${score} por debajo del umbral mínimo (${MIN_SCORE_MANUAL_REVIEW}).`;
  } else {
    decision = 'MANUAL_REVIEW';
    reason = 'Combinación de monto y score requiere revisión manual.';
  }

  const decisionType = decision === 'MANUAL_REVIEW' && scoringResult ? 'SYSTEM_ESCALATION' : 'AUTOMATIC';

  const approvalDecision = await insertApprovalDecision({
    applicationId,
    scoringResultId: scoringResult?.id || null,
    decision,
    decisionType,
    reason,
  });

  await updateApplicationStatus(applicationId, decision);

  if (applicantId) {
    await auditService.recordCreditDecisionAudit({
      applicationId,
      applicantId,
      scoringResultId: scoringResult?.id || null,
      inputVariables: {
        requestedAmount,
        score,
        autoApprovalLimit: AUTO_APPROVAL_LIMIT,
        minScoreApproval: MIN_SCORE_APPROVAL,
        minScoreManualReview: MIN_SCORE_MANUAL_REVIEW,
      },
      modelWeights: null,
      shapValues: scoringResult?.shap_values || null,
      finalScore: score || null,
      finalDecision: decision,
      decisionReason: reason,
      modelVersion: scoringResult?.model_version || null,
      signedBySystem: 'neolend-approval-service',
    });
  } else {
    console.warn(`[approval] No se pudo resolver applicantId para auditar la decisión de ${applicationId}; se omite credit_decision_audit.`);
  }

  await auditService.recordEvent({
    aggregateId: applicationId,
    aggregateType: 'CreditApplication',
    eventType: 'AutomaticApprovalCompleted',
    eventData: { decision, decisionType, reason, score, requestedAmount },
    metadata: { source: 'approval-service' },
  });

  return {
    applicationId,
    decision,
    decisionType,
    reason,
    score: score || null,
    approvalDecisionId: approvalDecision.id,
  };
}

/**
 * Revisión manual: un analista resuelve una solicitud escalada (montos > USD
 * 500 o casos ambiguos) con toda la evidencia pre-cargada.
 */
async function runManualReview({ applicationId, analystId, decision, reason }) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw new ValidationError('decision debe ser APPROVED o REJECTED');
  }

  const scoringResult = await scoringService.getLatestResult(applicationId);
  const application = await scoringService.getCreditApplication(applicationId);

  let applicantId = scoringResult?.applicant_id || application?.applicant_id || null;
  if (!applicantId) {
    const scoringStartedData = await auditService.getLatestEventData(applicationId, 'ScoringStarted');
    applicantId = scoringStartedData?.applicantId || null;
  }

  const approvalDecision = await insertApprovalDecision({
    applicationId,
    scoringResultId: scoringResult?.id || null,
    decision,
    decisionType: 'MANUAL',
    reason,
    decidedBy: analystId,
  });

  await updateApplicationStatus(applicationId, decision);

  if (applicantId) {
    await auditService.recordCreditDecisionAudit({
      applicationId,
      applicantId,
      scoringResultId: scoringResult?.id || null,
      inputVariables: {
        requestedAmount: application?.requested_amount ?? null,
        score: scoringResult?.score ?? null,
        analystId,
      },
      modelWeights: null,
      shapValues: scoringResult?.shap_values || null,
      finalScore: scoringResult?.score ?? null,
      finalDecision: decision,
      decisionReason: reason,
      modelVersion: scoringResult?.model_version || null,
      signedBySystem: 'neolend-approval-service',
    });
  } else {
    console.warn(`[approval] No se pudo resolver applicantId para auditar la revisión manual de ${applicationId}; se omite credit_decision_audit.`);
  }

  await auditService.recordEvent({
    aggregateId: applicationId,
    aggregateType: 'CreditApplication',
    eventType: 'ManualReviewCompleted',
    eventData: { decision, reason, analystId },
    metadata: { source: 'approval-service' },
  });

  return {
    applicationId,
    decision,
    decisionType: 'MANUAL',
    reason,
    decidedBy: analystId,
    approvalDecisionId: approvalDecision.id,
  };
}

async function getDecision(applicationId) {
  const result = await query(
    `SELECT application_id, decision, decision_type, reason, decided_by, decided_at
     FROM scoring.approval_decisions
     WHERE application_id = $1
     ORDER BY decided_at DESC LIMIT 1`,
    [applicationId]
  );
  return result.rows[0] || null;
}

module.exports = {
  runAutomaticApproval,
  runManualReview,
  getDecision,
  ValidationError,
  AUTO_APPROVAL_LIMIT,
  MIN_SCORE_APPROVAL,
  MIN_SCORE_MANUAL_REVIEW,
};
