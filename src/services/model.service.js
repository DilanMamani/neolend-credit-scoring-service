/**
 * Gestión Blue/Green del modelo de scoring.
 *
 * Permite actualizar el modelo de ML sin downtime: siempre hay un modelo
 * ACTIVO atendiendo tráfico y uno STANDBY listo para tomar el relevo. El
 * "switch" es instantáneo en memoria (no hay redeploy ni caída de servicio).
 */

const MODEL_REGISTRY = {
  'model-v2-green': {
    version: 'model-v2-green',
    weights: {
      credit_bureau_score: 0.30,
      utility_payment_score: 2.00,
      wallet_transaction_score: 1.50,
      ecommerce_score: 1.20,
      mobile_topup_score: 1.00,
    },
  },
  'model-v2-blue': {
    version: 'model-v2-blue',
    weights: {
      credit_bureau_score: 0.34,
      utility_payment_score: 1.85,
      wallet_transaction_score: 1.65,
      ecommerce_score: 1.10,
      mobile_topup_score: 1.05,
    },
  },
};

let state = {
  activeModel: process.env.ACTIVE_MODEL || 'model-v2-green',
  standbyModel: process.env.STANDBY_MODEL || 'model-v2-blue',
  strategy: 'BLUE_GREEN_DEPLOYMENT',
  lastSwitchAt: null,
};

function ensureRegistered(version) {
  if (!MODEL_REGISTRY[version]) {
    MODEL_REGISTRY[version] = {
      version,
      weights: MODEL_REGISTRY[state.activeModel].weights,
    };
  }
}

function getCurrent() {
  return { ...state };
}

function getActiveModelConfig() {
  ensureRegistered(state.activeModel);
  return MODEL_REGISTRY[state.activeModel];
}

/**
 * Cambia el modelo activo de forma instantánea (sin downtime). El modelo que
 * estaba activo pasa a standby, listo para un rollback igualmente instantáneo.
 */
function switchModel(targetModel) {
  if (!targetModel || typeof targetModel !== 'string') {
    throw new Error('targetModel es requerido');
  }

  ensureRegistered(targetModel);

  const previousActive = state.activeModel;
  state = {
    activeModel: targetModel,
    standbyModel: previousActive,
    strategy: 'BLUE_GREEN_DEPLOYMENT',
    lastSwitchAt: new Date().toISOString(),
  };

  return { previousActive, ...state };
}

module.exports = {
  getCurrent,
  getActiveModelConfig,
  switchModel,
  MODEL_REGISTRY,
};
