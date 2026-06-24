const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUUID(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Convierte a número si es posible (acepta number o string numérica). */
function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

module.exports = { isUUID, isFiniteNumber, toNumberOrNull, UUID_REGEX };
