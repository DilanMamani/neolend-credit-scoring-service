/**
 * Circuit breaker + caché inteligente + rate limiter para el buró de crédito.
 *
 * El buró nacional corre en un mainframe IBM Z con API SOAP de los años 2000:
 *   - límite duro de 10 consultas/segundo
 *   - latencia típica de 8-15 segundos
 *   - falla intermitentemente
 *
 * Este módulo aísla esa inestabilidad para que el resto del pipeline de scoring
 * nunca dependa de la disponibilidad real del mainframe.
 */

const STATES = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

const TIMEOUT_MS = Number(process.env.CREDIT_BUREAU_TIMEOUT_MS || 15000);
const FAILURE_THRESHOLD = Number(process.env.CREDIT_BUREAU_FAILURE_THRESHOLD || 5);
const RESET_TIMEOUT_MS = Number(process.env.CREDIT_BUREAU_RESET_TIMEOUT_MS || 30000);
const RATE_LIMIT_PER_SECOND = Number(process.env.CREDIT_BUREAU_RATE_LIMIT || 10);

// Simulación de comportamiento del mainframe. Por defecto se mantiene rápido
// para que la demo sea usable; CREDIT_BUREAU_FORCE_SLOW=true reproduce la
// latencia real de 8-15s descrita en el kata.
const FORCE_SLOW = String(process.env.CREDIT_BUREAU_FORCE_SLOW || 'false') === 'true';
const FAILURE_RATE = Number(process.env.CREDIT_BUREAU_FAILURE_RATE || 0.12);

class CircuitBreaker {
  constructor({ failureThreshold, resetTimeoutMs, timeoutMs }) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.timeoutMs = timeoutMs;

    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.cache = new Map(); // key -> { value, expiresAt }
    this.cacheTtlMs = 10 * 60 * 1000; // 10 minutos de caché inteligente

    // Rate limiter tipo token bucket (10 consultas/segundo del mainframe)
    this.tokens = RATE_LIMIT_PER_SECOND;
    this.maxTokens = RATE_LIMIT_PER_SECOND;
    setInterval(() => {
      this.tokens = this.maxTokens;
    }, 1000).unref?.();
  }

  getState() {
    if (this.state === STATES.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.resetTimeoutMs) {
        this.state = STATES.HALF_OPEN;
      }
    }
    return this.state;
  }

  _getCache(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  _setCache(key, value) {
    this.cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
  }

  async _withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('CREDIT_BUREAU_TIMEOUT')), this.timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async _acquireToken() {
    while (this.tokens <= 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.tokens -= 1;
  }

  _onSuccess() {
    this.failureCount = 0;
    this.state = STATES.CLOSED;
  }

  _onFailure() {
    this.failureCount += 1;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = STATES.OPEN;
    }
  }

  /**
   * Ejecuta fn() protegido por el circuito. Si el circuito está OPEN usa la
   * caché inteligente; si no hay caché disponible, lanza error controlado.
   */
  async execute(cacheKey, fn) {
    const currentState = this.getState();

    if (currentState === STATES.OPEN) {
      const cached = this._getCache(cacheKey);
      if (cached) {
        return { ...cached, fromCache: true, circuitState: this.state };
      }
      throw new CircuitOpenError('Circuito abierto y sin datos en caché para el buró de crédito');
    }

    await this._acquireToken();

    try {
      const result = await this._withTimeout(fn());

      if (currentState === STATES.HALF_OPEN) {
        this._onSuccess();
      } else {
        this.failureCount = 0;
      }

      this._setCache(cacheKey, result);
      return { ...result, fromCache: false, circuitState: this.state };
    } catch (err) {
      this._onFailure();

      const cached = this._getCache(cacheKey);
      if (cached) {
        return { ...cached, fromCache: true, circuitState: this.state, degraded: true };
      }
      throw err;
    }
  }

  getStatus() {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      timeoutMs: this.timeoutMs,
      cachedKeys: this.cache.size,
    };
  }
}

class CircuitOpenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

const creditBureauBreaker = new CircuitBreaker({
  failureThreshold: FAILURE_THRESHOLD,
  resetTimeoutMs: RESET_TIMEOUT_MS,
  timeoutMs: TIMEOUT_MS,
});

/** Simula la llamada SOAP real al mainframe IBM Z del buró de crédito. */
async function callSoapCreditBureau(documentNumber) {
  const latencyMs = FORCE_SLOW
    ? 8000 + Math.random() * 7000
    : 80 + Math.random() * 400;

  await new Promise((r) => setTimeout(r, latencyMs));

  if (Math.random() < FAILURE_RATE) {
    throw new Error('SOAP_FAULT: mainframe IBM Z no respondió a tiempo');
  }

  const score = 480 + Math.floor(Math.random() * 350); // 480-830
  return {
    documentNumber,
    creditBureauScore: score,
    source: 'SOAP_MAINFRAME',
    latencyMs: Math.round(latencyMs),
    queriedAt: new Date().toISOString(),
  };
}

/** Punto de entrada usado por el scoring-service. */
async function queryCreditBureau(documentNumber) {
  return creditBureauBreaker.execute(`bureau:${documentNumber}`, () =>
    callSoapCreditBureau(documentNumber)
  );
}

module.exports = {
  STATES,
  creditBureauBreaker,
  queryCreditBureau,
  CircuitOpenError,
};
