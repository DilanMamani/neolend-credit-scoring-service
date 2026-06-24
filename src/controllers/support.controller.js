const { ok, fail } = require('../utils/response');
const { isUUID } = require('../utils/validate');
const supportService = require('../services/support.service');

async function getApplications(req, res, next) {
  try {
    const { status, limit, applicantId } = req.query;
    if (applicantId !== undefined && !isUUID(applicantId)) {
      return fail(res, 'applicantId debe ser un UUID válido', 400);
    }

    const applications = await supportService.listApplications({ status, limit, applicantId });
    return ok(res, applications);
  } catch (err) {
    next(err);
  }
}

async function getApplicationDetail(req, res, next) {
  try {
    const { applicationId } = req.params;
    if (!isUUID(applicationId)) {
      return fail(res, 'applicationId debe ser un UUID válido', 400);
    }

    const detail = await supportService.getApplicationDetail(applicationId);
    if (!detail) return fail(res, 'Solicitud de crédito no encontrada', 404);
    return ok(res, detail);
  } catch (err) {
    next(err);
  }
}

async function getApplicants(req, res, next) {
  try {
    const { limit, userId } = req.query;
    if (userId !== undefined && !isUUID(userId)) {
      return fail(res, 'userId debe ser un UUID válido', 400);
    }

    const applicants = await supportService.listApplicants({ limit, userId });
    return ok(res, applicants);
  } catch (err) {
    next(err);
  }
}

async function getAuditTrail(req, res, next) {
  try {
    const { applicationId } = req.params;
    if (!isUUID(applicationId)) {
      return fail(res, 'applicationId debe ser un UUID válido', 400);
    }

    const trail = await supportService.getAuditTrail(applicationId);
    return ok(res, trail);
  } catch (err) {
    next(err);
  }
}

module.exports = { getApplications, getApplicationDetail, getApplicants, getAuditTrail };
