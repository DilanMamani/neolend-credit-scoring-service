const express = require('express');
const cors = require('cors');

const scoringRoutes = require('./routes/scoring.routes');
const approvalRoutes = require('./routes/approval.routes');
const supportRoutes = require('./routes/support.routes');
const { notFoundHandler, errorHandler } = require('./middlewares/errorHandler');

const app = express();

// CORS abierto por defecto para no acoplar este servicio a ningún frontend
// específico (applicant, admin, o cualquier puerto local). Si se define
// CORS_ORIGIN (lista separada por comas) se restringe a esos orígenes.
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  })
);

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'neolend-credit-scoring-service',
    port: Number(process.env.PORT || 3001),
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/scoring', scoringRoutes);
app.use('/api/approval', approvalRoutes);
app.use('/api/support', supportRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
