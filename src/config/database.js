const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[DB] Error inesperado en el pool de PostgreSQL:', err.message);
});

async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[DB] ${duration}ms | ${text.split('\n')[0].trim()}`);
  }
  return result;
}

async function testConnection() {
  const result = await pool.query('SELECT NOW() as now');
  return result.rows[0].now;
}

module.exports = { pool, query, testConnection };
