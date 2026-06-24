/**
 * Endpoints de soporte/lectura para que los frontends (applicant, admin) y
 * otros equipos puedan integrar sin depender de que applicant-service o
 * credit-application-service ya estén desplegados. Son de solo lectura sobre
 * las mismas tablas Neon que ya usa el motor de scoring/aprobación.
 */

const { query } = require('../config/database');

async function listApplications({ status, limit = 50 }) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE ca.status = $${params.length}`;
  }
  params.push(Math.min(Number(limit) || 50, 200));

  const result = await query(
    `SELECT ca.id AS application_id, ca.applicant_id, ca.requested_amount, ca.currency,
            ca.term_months, ca.purpose, ca.status, ca.created_at,
            sr.score, sr.risk_level, sr.recommendation, sr.model_version
     FROM credit.credit_applications ca
     LEFT JOIN LATERAL (
       SELECT score, risk_level, recommendation, model_version
       FROM scoring.scoring_results
       WHERE application_id = ca.id
       ORDER BY created_at DESC LIMIT 1
     ) sr ON true
     ${where}
     ORDER BY ca.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

async function getApplicationDetail(applicationId) {
  const appResult = await query(
    `SELECT id AS application_id, applicant_id, requested_amount, currency, term_months,
            purpose, status, created_at, updated_at
     FROM credit.credit_applications WHERE id = $1`,
    [applicationId]
  );
  const application = appResult.rows[0];
  if (!application) return null;

  const applicantResult = await query(
    `SELECT id, document_type, document_number, employment_status, monthly_income, profile_status
     FROM applicant.applicants WHERE id = $1`,
    [application.applicant_id]
  );

  const scoringResult = await query(
    `SELECT * FROM scoring.scoring_results WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [applicationId]
  );

  const decisionResult = await query(
    `SELECT * FROM scoring.approval_decisions WHERE application_id = $1 ORDER BY decided_at DESC LIMIT 1`,
    [applicationId]
  );

  const snapshotResult = await query(
    `SELECT * FROM scoring.external_data_snapshots WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [applicationId]
  );

  return {
    application,
    applicant: applicantResult.rows[0] || null,
    scoring: scoringResult.rows[0] || null,
    decision: decisionResult.rows[0] || null,
    externalDataSnapshot: snapshotResult.rows[0] || null,
  };
}

async function listApplicants({ limit = 50 } = {}) {
  const result = await query(
    `SELECT id, document_type, document_number, employment_status, monthly_income, profile_status, created_at
     FROM applicant.applicants
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(Number(limit) || 50, 200)]
  );
  return result.rows;
}

async function getAuditTrail(applicationId) {
  const auditService = require('./audit.service');
  const [events, decisionAudit] = await Promise.all([
    auditService.getEventStream(applicationId),
    auditService.getCreditDecisionAudit(applicationId),
  ]);
  return { applicationId, events, decisionAudit };
}

module.exports = { listApplications, getApplicationDetail, listApplicants, getAuditTrail };
