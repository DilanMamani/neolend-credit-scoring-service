/**
 * Seed de demo "super cargado" para NeoLend.
 *
 * Qué hace:
 *  1. Crea ~10 solicitantes sintéticos + sus solicitudes de crédito (montos,
 *     plazos y propósitos variados) directo en Neon (credit-application-service
 *     todavía no existe como microservicio separado).
 *  2. Crea 2 solicitudes para el usuario SOLICITANTE real (dilanmamanip@gmail.com),
 *     una pensada para aprobación automática y otra para revisión manual.
 *  3. Corre TODAS esas solicitudes por el pipeline real de este microservicio
 *     (POST /api/scoring/evaluate y /api/approval/automatic contra
 *     http://localhost:3001) para generar scoring_results, external_data_snapshots,
 *     approval_decisions y la auditoría completa (event_store + credit_decision_audit)
 *     con datos auténticos, no inventados a mano.
 *  4. Para las solicitudes que escalan a MANUAL_REVIEW, resuelve la mayoría con el
 *     usuario ANALISTA real (dilanmamanipamuri@gmail.com) vía
 *     POST /api/approval/manual-review, dejando un par sin resolver para que la
 *     cola de revisión manual del frontend no esté vacía.
 *  5. Siembra datos periféricos (préstamos, desembolsos, cuotas, fraude,
 *     métricas de inversionista, progreso educativo, notificaciones y un
 *     reporte regulatorio) vía SQL directo, ya que esos microservicios
 *     todavía no existen — son solo para que las demás pantallas del
 *     frontend tengan algo que mostrar.
 *
 * Requiere:
 *   - neolend-credit-scoring-service corriendo en localhost:3001 (npm run dev)
 *   - DATABASE_URL configurado en .env (Neon)
 *
 * Uso:
 *   node scripts/seed-demo.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const API_BASE = process.env.SEED_API_BASE || 'http://localhost:3001/api';

// Usuarios reales ya registrados en auth-service (ver README "Usuarios de prueba").
const REAL = {
  solicitanteUserId: '259411e3-cb6c-41d8-94b1-4c7b2395ce30',
  solicitanteApplicantId: '0927339c-539c-41ec-8d7d-d0517371c46b',
  analistaUserId: 'c4e0e278-f789-4e33-b7bb-f480ca30b479',
  reguladorUserId: '14b3a4c7-0a1b-457d-854a-b33a89fd2b83',
  inversionistaUserId: 'a215c895-5293-4044-98b4-dff7a169bcda',
  comercioUserId: '0581939f-7d38-4c34-b0b7-a4678354a31d',
};

const PURPOSES = [
  'Compra de inventario para pequeño negocio',
  'Capital de trabajo para emprendimiento',
  'Compra de equipos o herramientas',
  'Gastos de salud',
  'Educación',
  'Mejoras del hogar',
  'Ampliación de negocio familiar',
  'Compra de celular para trabajo',
  'Pago de servicios y deudas pequeñas',
];

const CITIES = ['La Paz', 'Cochabamba', 'Santa Cruz', 'Sucre', 'El Alto', 'Tarija'];
const EMPLOYMENT = ['DEPENDENT', 'INDEPENDENT', 'INFORMAL'];

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[rand(0, arr.length - 1)]; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function pad(n) { return String(n).padStart(2, '0'); }
function randomBirthDate() {
  return `19${rand(70, 99)}-${pad(rand(1, 12))}-${pad(rand(1, 28))}`;
}

async function api(path, method, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.success) throw new Error(`${method} ${path} -> ${json.error?.message}`);
  return json.data;
}

async function createSyntheticApplicant(client, index) {
  const result = await client.query(
    `INSERT INTO applicant.applicants
       (user_id, document_type, document_number, birth_date, address, city, country,
        employment_status, monthly_income, profile_status)
     VALUES (gen_random_uuid(), 'CI', $1, $2, $3, $4, 'Bolivia', $5, $6, 'COMPLETE')
     RETURNING id`,
    [
      `SEED-${Date.now()}-${index}`,
      randomBirthDate(),
      `Calle Demo #${rand(100, 999)}`,
      pick(CITIES),
      pick(EMPLOYMENT),
      rand(900, 6000),
    ]
  );
  return result.rows[0].id;
}

async function createApplication(client, applicantId, amount, termMonths, purpose) {
  const result = await client.query(
    `INSERT INTO credit.credit_applications
       (applicant_id, requested_amount, currency, term_months, purpose, status)
     VALUES ($1, $2, 'USD', $3, $4, 'CREATED')
     RETURNING id`,
    [applicantId, amount, termMonths, purpose]
  );
  return result.rows[0].id;
}

async function runPipeline(applicationId, applicantId, amount, { analystId, forceManualDecision } = {}) {
  await api('/scoring/evaluate', 'POST', { applicationId, applicantId, requestedAmount: amount });
  const approval = await api('/approval/automatic', 'POST', { applicationId });

  if (approval.decision === 'MANUAL_REVIEW' && forceManualDecision) {
    const decision = Math.random() < 0.7 ? 'APPROVED' : 'REJECTED';
    const reason = decision === 'APPROVED'
      ? 'Ingresos y comportamiento alternativo suficientes para sostener la cuota a pesar del monto elevado.'
      : 'El flujo de caja estimado no cubre con margen suficiente la cuota proyectada.';
    await api('/approval/manual-review', 'POST', { applicationId, analystId, decision, reason });
    return { ...approval, decision, decisionType: 'MANUAL' };
  }
  return approval;
}

async function seedLoanIfApproved(client, applicationId, applicantId, amount, termMonths, finalDecision) {
  if (finalDecision !== 'APPROVED') return null;

  const interestRate = 12.5;
  const loanResult = await client.query(
    `INSERT INTO credit.loans (application_id, applicant_id, approved_amount, interest_rate, term_months, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', NOW())
     RETURNING id`,
    [applicationId, applicantId, amount, interestRate, termMonths]
  );
  const loanId = loanResult.rows[0].id;

  const channel = pick(['WALLET', 'BANK', 'CORRESPONDENT']);
  await client.query(
    `INSERT INTO disbursement.disbursements
       (loan_id, applicant_id, amount, channel, destination_account, status, provider_reference, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'COMPLETED', $6, NOW())`,
    [loanId, applicantId, amount, channel, `${channel}-${rand(100000, 999999)}`, `TXN-${rand(100000, 999999)}`]
  );

  const monthly = Number(((amount * (1 + interestRate / 100)) / termMonths).toFixed(2));
  for (let i = 1; i <= termMonths; i++) {
    await client.query(
      `INSERT INTO collection.installments
         (loan_id, installment_number, due_date, amount, principal_amount, interest_amount, status)
       VALUES ($1, $2, CURRENT_DATE + ($3 * INTERVAL '30 days'), $4, $5, $6, 'PENDING')`,
      [loanId, i, i, monthly, Number((amount / termMonths).toFixed(2)), Number((monthly - amount / termMonths).toFixed(2))]
    );
  }
  return loanId;
}

async function seedFraudCheck(client, applicationId, applicantId, score) {
  const documentMatch = Math.min(99, Math.max(55, score / 10 + rand(-10, 15)));
  const biometricMatch = Math.min(98, Math.max(50, score / 10 + rand(-15, 10)));
  const riskLevel = documentMatch > 85 && biometricMatch > 85 ? 'LOW' : documentMatch > 65 ? 'MEDIUM' : 'HIGH';
  await client.query(
    `INSERT INTO fraud.fraud_checks
       (application_id, applicant_id, document_match_score, biometric_match_score,
        stolen_identity_match, suspicious_pattern, fraud_risk_level, status)
     VALUES ($1, $2, $3, $4, FALSE, $5, $6, 'COMPLETED')`,
    [applicationId, applicantId, documentMatch.toFixed(2), biometricMatch.toFixed(2), riskLevel === 'HIGH', riskLevel]
  );
}

async function seedInvestorMetrics(client) {
  const existing = await client.query(
    `SELECT id FROM investor.investor_profiles WHERE user_id = $1`,
    [REAL.inversionistaUserId]
  );
  let investorId = existing.rows[0]?.id;
  if (!investorId) {
    const inserted = await client.query(
      `INSERT INTO investor.investor_profiles (user_id, institution_name, fund_type)
       VALUES ($1, 'Fondo Inversion Demo', 'PRIVATE_DEBT') RETURNING id`,
      [REAL.inversionistaUserId]
    );
    investorId = inserted.rows[0].id;
  }

  await client.query(
    `INSERT INTO investor.portfolio_metrics
       (investor_id, total_invested, active_loans, delinquency_rate, projected_cashflow, internal_rate_return, risk_exposure)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [investorId, rand(200000, 400000), rand(120, 260), (Math.random() * 6).toFixed(2),
      rand(250000, 450000), (12 + Math.random() * 10).toFixed(2), (8 + Math.random() * 10).toFixed(2)]
  );
}

async function seedEducationAndNotifications(client) {
  const courses = await client.query(`SELECT id FROM education.courses LIMIT 3`);
  if (courses.rows.length > 0) {
    await client.query(
      `INSERT INTO education.user_course_progress (applicant_id, course_id, progress_percent, completed, completed_at)
       VALUES ($1, $2, 100, TRUE, NOW())
       ON CONFLICT DO NOTHING`,
      [REAL.solicitanteApplicantId, courses.rows[0].id]
    );
  }

  await client.query(
    `INSERT INTO notification.notifications (user_id, channel, recipient, subject, message, status, sent_at)
     VALUES ($1, 'EMAIL', 'dilanmamanip@gmail.com', 'Bienvenido a NeoLend', 'Tu cuenta fue creada correctamente.', 'SENT', NOW())`,
    [REAL.solicitanteUserId]
  );
}

async function seedRegulatoryReport(client) {
  await client.query(
    `INSERT INTO audit.regulatory_reports (report_period, regulator_name, report_url, generated_by)
     VALUES ($1, 'Superintendencia Demo', $2, $3)`,
    ['2026-06', 'https://storage.neolend.local/reports/regulatory-report-2026-06.pdf', REAL.reguladorUserId]
  );
}

async function main() {
  const client = await pool.connect();
  console.log('Conectado a Neon. Iniciando seed de demo...\n');

  const summary = [];

  try {
    // ── 1. Solicitudes del usuario SOLICITANTE real (idempotente) ────────
    const existingReal = await client.query(
      `SELECT COUNT(*) FROM credit.credit_applications WHERE applicant_id = $1`,
      [REAL.solicitanteApplicantId]
    );
    if (Number(existingReal.rows[0].count) > 0) {
      console.log('El solicitante real ya tiene solicitudes; se omite (evita duplicados).');
      summary.push('Solicitudes reales: ya existían, no se duplicaron.');
    } else {
      console.log('Creando solicitudes para dilanmamanip@gmail.com...');
      const realApp1 = await createApplication(client, REAL.solicitanteApplicantId, 480, 6, PURPOSES[0]);
      const realApp2 = await createApplication(client, REAL.solicitanteApplicantId, 1800, 12, 'Ampliación de negocio familiar');

      const realResult1 = await runPipeline(realApp1, REAL.solicitanteApplicantId, 480, { analystId: REAL.analistaUserId, forceManualDecision: true });
      await sleep(150);
      const realResult2 = await runPipeline(realApp2, REAL.solicitanteApplicantId, 1800, { analystId: REAL.analistaUserId, forceManualDecision: true });

      await seedLoanIfApproved(client, realApp1, REAL.solicitanteApplicantId, 480, 6, realResult1.decision);
      await seedLoanIfApproved(client, realApp2, REAL.solicitanteApplicantId, 1800, 12, realResult2.decision);
      await seedFraudCheck(client, realApp1, REAL.solicitanteApplicantId, realResult1.score || 700);
      await seedFraudCheck(client, realApp2, REAL.solicitanteApplicantId, realResult2.score || 700);

      summary.push(`Solicitud real #1 (USD 480): ${realResult1.decision}`);
      summary.push(`Solicitud real #2 (USD 1800): ${realResult2.decision}`);
    }

    // ── 2. Solicitantes y solicitudes sintéticas (volumen) ───────────────
    console.log('Creando solicitantes y solicitudes sintéticas...');
    const SYNTHETIC_COUNT = 10;
    for (let i = 0; i < SYNTHETIC_COUNT; i++) {
      const applicantId = await createSyntheticApplicant(client, i);
      const amount = pick([120, 250, 350, 480, 500, 650, 900, 1200, 1800, 2500]);
      const termMonths = pick([3, 4, 6, 9, 12, 18, 24]);
      const purpose = pick(PURPOSES);
      const applicationId = await createApplication(client, applicantId, amount, termMonths, purpose);

      // deja ~3 de cada 10 sin resolución manual para poblar la cola del analista
      const forceManualDecision = i % 3 !== 0;

      try {
        const result = await runPipeline(applicationId, applicantId, amount, { analystId: REAL.analistaUserId, forceManualDecision });
        await seedLoanIfApproved(client, applicationId, applicantId, amount, termMonths, result.decision);
        await seedFraudCheck(client, applicationId, applicantId, result.score || 600);
        summary.push(`Sintética #${i + 1} (USD ${amount}): ${result.decision}`);
      } catch (err) {
        summary.push(`Sintética #${i + 1} (USD ${amount}): ERROR -> ${err.message}`);
      }

      await sleep(120); // respeta el rate limiter del circuit breaker (10 req/s)
    }

    // ── 2.5. Garantiza que queden casos pendientes para el analista ──────
    // (idempotente: solo agrega si hay menos de 3 MANUAL_REVIEW sin resolver)
    console.log('Verificando cola de revisión manual...');
    let pendingCount = Number(
      (await client.query(`SELECT COUNT(*) FROM credit.credit_applications WHERE status = 'MANUAL_REVIEW'`)).rows[0].count
    );
    let attempts = 0;
    while (pendingCount < 3 && attempts < 12) {
      attempts++;
      const applicantId = await createSyntheticApplicant(client, 100 + attempts);
      const amount = pick([900, 1200, 1500, 1800]); // > AUTO_APPROVAL_LIMIT a propósito
      const applicationId = await createApplication(client, applicantId, amount, 12, pick(PURPOSES));
      const result = await runPipeline(applicationId, applicantId, amount, { forceManualDecision: false });
      if (result.decision === 'MANUAL_REVIEW') {
        pendingCount++;
        summary.push(`Cola analista (USD ${amount}): MANUAL_REVIEW pendiente`);
      }
      await sleep(120);
    }

    // ── 3. Datos periféricos ──────────────────────────────────────────────
    console.log('Sembrando datos periféricos (inversionista, educación, notificaciones, reporte regulatorio)...');
    await seedInvestorMetrics(client);
    await seedEducationAndNotifications(client);
    await seedRegulatoryReport(client);

    console.log('\n=== RESUMEN DEL SEED ===');
    summary.forEach((line) => console.log(' -', line));
    console.log('\nListo. Revisa GET /api/support/applications para ver todo lo creado.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed falló:', err);
  process.exit(1);
});
