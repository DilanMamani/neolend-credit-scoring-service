require('dotenv').config();

const app = require('./app');
const { testConnection } = require('./config/database');

const PORT = Number(process.env.PORT || 3001);

async function start() {
  try {
    const now = await testConnection();
    console.log(`[DB] Conectado a Neon PostgreSQL. Hora del servidor: ${now}`);
  } catch (err) {
    console.error('[DB] No se pudo conectar a la base de datos:', err.message);
    console.error('[DB] El servicio seguirá iniciando; las rutas que usan DB fallarán hasta que la conexión se restablezca.');
  }

  app.listen(PORT, () => {
    console.log(`NeoLend Credit Scoring Service escuchando en puerto ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

start();
