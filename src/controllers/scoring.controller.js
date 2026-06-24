const crypto = require('crypto');
const { ok, fail } = require('../utils/response');
const { isUUID, toNumberOrNull } = require('../utils/validate');
const scoringService = require('../services/scoring.service');
const modelService = require('../services/model.service');
const auditService = require('../services/audit.service');
const { creditBureauBreaker } = require('../services/circuitBreaker.service');

async function evaluate(req, res, next) {
  try {
    const { applicationId, applicantId, requestedAmount } = req.body || {};

    if (!isUUID(applicationId)) {
      return fail(res, 'applicationId es requerido y debe ser un UUID válido', 400);
    }
    if (!isUUID(applicantId)) {
      return fail(res, 'applicantId es requerido y debe ser un UUID válido', 400);
    }

    let amount;
    if (requestedAmount !== undefined) {
      amount = toNumberOrNull(requestedAmount);
      if (amount === null || Number.isNaN(amount) || amount <= 0) {
        return fail(res, 'requestedAmount debe ser un número mayor a 0', 400);
      }
    }

    const result = await scoringService.evaluate({ applicationId, applicantId, requestedAmount: amount });

    return ok(res, {
      applicationId: result.applicationId,
      applicantId: result.applicantId,
      score: result.score,
      riskLevel: result.riskLevel,
      recommendation: result.recommendation,
      modelVersion: result.modelVersion,
      processingTimeMs: result.processingTimeMs,
      shapValues: result.shapValues,
      requestedAmount: result.requestedAmount,
    }, 201);
  } catch (err) {
    next(err);
  }
}

async function getResult(req, res, next) {
  try {
    const { applicationId } = req.params;
    if (!isUUID(applicationId)) {
      return fail(res, 'applicationId debe ser un UUID válido', 400);
    }

    const result = await scoringService.getLatestResult(applicationId);
    if (!result) return fail(res, 'No existe resultado de scoring para esta solicitud', 404);

    return ok(res, {
      applicationId: result.application_id,
      applicantId: result.applicant_id,
      score: result.score,
      riskLevel: result.risk_level,
      recommendation: result.recommendation,
      modelVersion: result.model_version,
      shapValues: result.shap_values,
      processingTimeMs: result.processing_time_ms,
      createdAt: result.created_at,
    });
  } catch (err) {
    next(err);
  }
}

async function getExplanation(req, res, next) {
  try {
    const { applicationId } = req.params;
    if (!isUUID(applicationId)) {
      return fail(res, 'applicationId debe ser un UUID válido', 400);
    }

    const explanation = await scoringService.getExplanation(applicationId);
    if (!explanation) return fail(res, 'No existe resultado de scoring para esta solicitud', 404);
    return ok(res, explanation);
  } catch (err) {
    next(err);
  }
}

async function getCurrentModel(req, res, next) {
  try {
    return ok(res, modelService.getCurrent());
  } catch (err) {
    next(err);
  }
}

async function switchModel(req, res, next) {
  try {
    const { targetModel } = req.body || {};
    if (!targetModel || typeof targetModel !== 'string' || !targetModel.trim()) {
      return fail(res, 'targetModel es requerido (ej: "model-v2-blue")', 400);
    }

    const result = modelService.switchModel(targetModel.trim());

    await auditService.recordEvent({
      aggregateId: crypto.randomUUID(),
      aggregateType: 'ScoringModel',
      eventType: 'ModelSwitched',
      eventData: result,
      metadata: { source: 'scoring-service' },
    });

    return ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function circuitBreakerStatus(req, res, next) {
  try {
    return ok(res, creditBureauBreaker.getStatus());
  } catch (err) {
    next(err);
  }
}

module.exports = {
  evaluate,
  getResult,
  getExplanation,
  getCurrentModel,
  switchModel,
  circuitBreakerStatus,
};
