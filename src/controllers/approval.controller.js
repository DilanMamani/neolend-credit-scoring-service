const { ok, fail } = require('../utils/response');
const { isUUID, toNumberOrNull } = require('../utils/validate');
const approvalService = require('../services/approval.service');

const VALID_DECISIONS = ['APPROVED', 'REJECTED'];

async function automatic(req, res, next) {
  try {
    const { applicationId, requestedAmount } = req.body || {};
    if (!isUUID(applicationId)) {
      return fail(res, 'applicationId es requerido y debe ser un UUID válido', 400);
    }

    let amountOverride;
    if (requestedAmount !== undefined) {
      amountOverride = toNumberOrNull(requestedAmount);
      if (amountOverride === null || Number.isNaN(amountOverride) || amountOverride <= 0) {
        return fail(res, 'requestedAmount debe ser un número mayor a 0', 400);
      }
    }

    const result = await approvalService.runAutomaticApproval(applicationId, amountOverride);
    return ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function manualReview(req, res, next) {
  try {
    const { applicationId, analystId, decision, reason } = req.body || {};

    if (!isUUID(applicationId)) {
      return fail(res, 'applicationId es requerido y debe ser un UUID válido', 400);
    }
    if (!VALID_DECISIONS.includes(decision)) {
      return fail(res, `decision es requerido y debe ser uno de: ${VALID_DECISIONS.join(', ')}`, 400);
    }
    if (analystId !== undefined && analystId !== null && !isUUID(analystId)) {
      return fail(res, 'analystId debe ser un UUID válido', 400);
    }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return fail(res, 'reason es requerido y debe describir el motivo de la decisión del analista', 400);
    }

    const result = await approvalService.runManualReview({ applicationId, analystId, decision, reason });
    return ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function getDecision(req, res, next) {
  try {
    const { applicationId } = req.params;
    if (!isUUID(applicationId)) {
      return fail(res, 'applicationId debe ser un UUID válido', 400);
    }

    const decision = await approvalService.getDecision(applicationId);
    if (!decision) return fail(res, 'No existe decisión para esta solicitud', 404);

    return ok(res, {
      applicationId: decision.application_id,
      decision: decision.decision,
      decisionType: decision.decision_type,
      reason: decision.reason,
      decidedBy: decision.decided_by,
      decidedAt: decision.decided_at,
    });
  } catch (err) {
    next(err);
  }
}

async function analystDecision(req, res, next) {
  try {
    const { applicationId } = req.params;
    const { analystId, decision, reason } = req.body || {};

    if (!isUUID(applicationId)) {
      return fail(res, 'applicationId debe ser un UUID válido', 400);
    }
    if (!VALID_DECISIONS.includes(decision)) {
      return fail(res, `decision es requerido y debe ser uno de: ${VALID_DECISIONS.join(', ')}`, 400);
    }
    if (analystId !== undefined && analystId !== null && !isUUID(analystId)) {
      return fail(res, 'analystId debe ser un UUID válido', 400);
    }

    const result = await approvalService.runManualReview({ applicationId, analystId, decision, reason });
    return ok(res, result);
  } catch (err) {
    next(err);
  }
}

module.exports = { automatic, manualReview, getDecision, analystDecision };
