const express = require('express');
const controller = require('../controllers/scoring.controller');

const router = express.Router();

router.post('/evaluate', controller.evaluate);
router.get('/result/:applicationId', controller.getResult);
router.get('/explanation/:applicationId', controller.getExplanation);
router.get('/model/current', controller.getCurrentModel);
router.post('/model/switch', controller.switchModel);
router.get('/circuit-breaker/status', controller.circuitBreakerStatus);

module.exports = router;
