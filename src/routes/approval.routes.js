const express = require('express');
const controller = require('../controllers/approval.controller');

const router = express.Router();

router.post('/automatic', controller.automatic);
router.post('/manual-review', controller.manualReview);
router.get('/decision/:applicationId', controller.getDecision);
router.patch('/:applicationId/analyst-decision', controller.analystDecision);

module.exports = router;
