/**
 * Generador de explicaciones tipo SHAP (simuladas, no librería real de SHAP).
 *
 * Convierte el aporte de cada variable al score final en un valor de impacto
 * normalizado entre -1 y 1, replicando la forma en que SHAP explica la
 * contribución de cada feature respecto al valor base del modelo.
 */

const FACTOR_DESCRIPTIONS = {
  credit_bureau_score: 'Historial en el buró de crédito nacional.',
  utility_payment_score: 'Comportamiento de pago de servicios públicos (luz, agua, telefonía).',
  wallet_transaction_score: 'Actividad y estabilidad en billeteras digitales.',
  ecommerce_score: 'Actividad de compra en plataformas de e-commerce.',
  mobile_topup_score: 'Frecuencia y consistencia de recargas móviles.',
  requested_amount: 'Relación entre el monto solicitado y la capacidad estimada del solicitante.',
};

const POSITIVE_NOTE = {
  credit_bureau_score: 'Buen historial crediticio en el buró nacional.',
  utility_payment_score: 'Buen comportamiento de pago de servicios públicos.',
  wallet_transaction_score: 'Actividad estable en billeteras digitales.',
  ecommerce_score: 'Actividad consistente en e-commerce sin contracargos.',
  mobile_topup_score: 'Recargas móviles frecuentes y estables.',
};

const NEGATIVE_NOTE = {
  credit_bureau_score: 'Historial crediticio débil o limitado en el buró nacional.',
  utility_payment_score: 'Pagos de servicios públicos atrasados o irregulares.',
  wallet_transaction_score: 'Baja actividad o inestabilidad en billeteras digitales.',
  ecommerce_score: 'Poca actividad de e-commerce o presencia de contracargos.',
  mobile_topup_score: 'Recargas móviles poco frecuentes o irregulares.',
};

/**
 * Calcula contribuciones SHAP simuladas a partir de las features crudas y los
 * pesos del modelo activo. La suma de |contribuciones| se normaliza a 1 para
 * que cada valor represente el peso relativo de esa variable en la decisión.
 */
function computeShapValues(features, weights) {
  const contributions = {};
  let totalAbs = 0;

  for (const [factor, rawValue] of Object.entries(features)) {
    const weight = weights[factor];
    if (weight === undefined || rawValue === undefined || rawValue === null) continue;
    const centeredValue = rawValue - 70; // 70 = punto neutro de las sub-métricas (0-100)
    const contribution = (centeredValue / 100) * weight;
    contributions[factor] = contribution;
    totalAbs += Math.abs(contribution);
  }

  const shapValues = {};
  for (const [factor, contribution] of Object.entries(contributions)) {
    shapValues[factor] = totalAbs === 0 ? 0 : Number((contribution / totalAbs).toFixed(4));
  }

  return shapValues;
}

function buildExplanation(score, riskLevel, shapValues) {
  const explanation = Object.entries(shapValues)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([factor, impact]) => ({
      factor,
      impact,
      description:
        impact >= 0
          ? POSITIVE_NOTE[factor] || FACTOR_DESCRIPTIONS[factor] || factor
          : NEGATIVE_NOTE[factor] || FACTOR_DESCRIPTIONS[factor] || factor,
    }));

  return { score, riskLevel, explanation };
}

module.exports = { computeShapValues, buildExplanation, FACTOR_DESCRIPTIONS };
