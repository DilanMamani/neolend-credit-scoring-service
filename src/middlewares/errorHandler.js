const { fail } = require('../utils/response');
const { ValidationError } = require('../services/scoring.service');
const { CircuitOpenError } = require('../services/circuitBreaker.service');

function notFoundHandler(req, res) {
  return fail(res, `Ruta no encontrada: ${req.method} ${req.originalUrl}`, 404);
}

function errorHandler(err, req, res, _next) {
  console.error('[ERROR]', err);

  if (err instanceof ValidationError || err.name === 'ValidationError') {
    return fail(res, err.message, 400);
  }

  if (err instanceof CircuitOpenError) {
    return fail(res, 'Buró de crédito no disponible (circuito abierto) y sin caché.', 503);
  }

  if (err.message === 'CREDIT_BUREAU_TIMEOUT') {
    return fail(res, 'Timeout consultando el buró de crédito.', 504);
  }

  // Errores comunes de PostgreSQL traducidos a respuestas 400 entendibles.
  if (err.code === '22P02') {
    return fail(res, 'Formato inválido en uno de los identificadores (UUID) enviados.', 400);
  }
  if (err.code === '23505') {
    return fail(res, 'Registro duplicado.', 409);
  }
  if (err.code === '23503') {
    return fail(res, 'Referencia inválida: el recurso relacionado no existe.', 400);
  }

  return fail(res, 'Error interno del servidor', 500, process.env.NODE_ENV !== 'production' ? err.message : undefined);
}

module.exports = { notFoundHandler, errorHandler };
