const express = require('express');
const controller = require('../controllers/support.controller');

const router = express.Router();

// Endpoints de solo lectura para que los frontends puedan poblar listas y
// detalle sin depender de applicant-service / credit-application-service.
router.get('/applications', controller.getApplications);
router.get('/applications/:applicationId', controller.getApplicationDetail);
router.get('/applicants', controller.getApplicants);
router.get('/audit/:applicationId', controller.getAuditTrail);

module.exports = router;
