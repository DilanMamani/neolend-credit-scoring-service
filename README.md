# NeoLend Credit Scoring Service

Microservicio de **scoring crediticio y aprobación automática/manual** para NeoLend Financial Corp. (Hackatón final 16/06/2026). Cubre los incisos II y III del kata (motor de score con fuentes alternativas + aprobación automática) y el inciso b) del contexto adicional (trazabilidad auditada con firma digital).

Construido en **Node.js + Express**, sin autenticación ni dependencias de otros microservicios: puede levantarse y probarse de forma completamente aislada contra la base de datos compartida en Neon.

---

## 1. Qué hace

1. **Recolecta datos alternativos** (buró de crédito, servicios públicos, billeteras digitales, e-commerce, recargas móviles) — si no existen para la solicitud, los genera él mismo, protegido por un circuit breaker que simula el mainframe SOAP del buró.
2. **Calcula un score** (300-850) con un modelo de pesos configurable, gestionado en **Blue/Green** (cambio de modelo sin downtime).
3. **Clasifica el riesgo** (`LOW` / `MEDIUM` / `HIGH`) y genera una **explicación tipo SHAP** simulada.
4. **Aprueba o rechaza automáticamente** créditos ≤ USD 500 con score alto; escala a **revisión manual** los montos mayores o casos ambiguos; permite que un analista resuelva esa revisión.
5. **Audita todo**: cada paso queda como evento inmutable encadenado por hash (estilo event sourcing) y cada decisión de crédito queda firmada digitalmente (HMAC-SHA256) en `audit.credit_decision_audit`, lista para la auditoría mensual de la Superintendencia.

---

## 2. Stack

| Componente | Elección |
|---|---|
| Runtime | Node.js (≥18) |
| Framework | Express 4 |
| Base de datos | PostgreSQL (Neon), acceso directo vía `pg` (Pool) |
| Auth | **Ninguna a propósito.** Este servicio no depende de `auth-service`; la seguridad de acceso (JWT, roles) se resuelve en el API Gateway / auth-service en producción. |
| Auditoría | `crypto` (núcleo de Node): hash chain SHA-256 + firma HMAC-SHA256 |
| Dev | `nodemon` |

Sin librerías de ML reales ni de SHAP: el "modelo" es una fórmula ponderada explicable y el SHAP es una explicación simulada — suficiente y defendible para el alcance del kata.

---

## 3. Estructura del proyecto

```
src/
├── index.js                       # bootstrap: conecta a Neon y levanta Express
├── app.js                         # configuración de Express (cors, json, logger, rutas)
├── config/
│   └── database.js                # Pool de pg + test de conexión
├── routes/
│   ├── scoring.routes.js
│   ├── approval.routes.js
│   └── support.routes.js          # endpoints de lectura para integrarse con frontends
├── controllers/
│   ├── scoring.controller.js
│   ├── approval.controller.js
│   └── support.controller.js
├── services/
│   ├── scoring.service.js         # pipeline completo de scoring
│   ├── approval.service.js        # reglas de aprobación automática/manual
│   ├── model.service.js           # blue/green del modelo
│   ├── shap.service.js            # explicación SHAP simulada
│   ├── circuitBreaker.service.js  # circuit breaker + caché + rate limiter del buró
│   ├── audit.service.js           # event sourcing + firma digital
│   └── support.service.js         # consultas de lectura (listas, detalle, trazabilidad)
├── middlewares/
│   └── errorHandler.js
└── utils/
    ├── response.js                # formato de respuesta { success, data | error }
    └── validate.js                # validación de UUID / números

scripts/
└── seed-demo.js                   # seed masivo: usuarios reales + datos sintéticos vía el pipeline real

postman/
├── NeoLend-Credit-Scoring.postman_collection.json
└── NeoLend-Local.postman_environment.json
```

---

## 4. Instalación y ejecución

```bash
cd neolend-credit-scoring-service
npm install
cp .env.example .env   # si no existe ya .env con las credenciales reales de Neon
npm run dev             # con nodemon (recarga automática)
npm start                # modo producción
```

El servidor corre por defecto en `http://localhost:3001`. Al iniciar, intenta conectarse a Neon y loguea la hora del servidor; si la base no está disponible, el proceso sigue arriba (las rutas que la usan fallarán hasta que la conexión se restablezca).

### Variables de entorno

Ver `.env.example` para la lista completa con valores por defecto. Las más relevantes:

| Variable | Uso |
|---|---|
| `PORT` | Puerto HTTP (default `3001`) |
| `DATABASE_URL` | Connection string de Neon (con `sslmode=require`) |
| `AUTO_APPROVAL_LIMIT` | Monto máximo aprobable sin intervención humana (default `500`) |
| `MIN_SCORE_APPROVAL` | Score mínimo para aprobación automática (default `700`) |
| `MIN_SCORE_MANUAL_REVIEW` | Score mínimo para no rechazar automáticamente (default `600`) |
| `ACTIVE_MODEL` / `STANDBY_MODEL` | Modelos blue/green iniciales |
| `CREDIT_BUREAU_TIMEOUT_MS` | Timeout del circuit breaker (default `15000`) |
| `CREDIT_BUREAU_FAILURE_THRESHOLD` | Fallos consecutivos para abrir el circuito (default `5`) |
| `CREDIT_BUREAU_RESET_TIMEOUT_MS` | Tiempo en `OPEN` antes de pasar a `HALF_OPEN` (default `30000`) |
| `CREDIT_BUREAU_RATE_LIMIT` | Consultas/segundo permitidas al buró simulado (default `10`) |
| `CREDIT_BUREAU_FORCE_SLOW` | `true` para forzar latencia real de 8-15s del kata (default `false`, rápido para demo) |
| `CREDIT_BUREAU_FAILURE_RATE` | Probabilidad de fallo simulado del SOAP (default `0.12`) |
| `AUDIT_ENABLED` | Activa/desactiva el registro en `audit.event_store` |
| `DIGITAL_SIGNATURE_SECRET` | Secreto HMAC para firmar eventos y decisiones |
| `CORS_ORIGIN` | Lista de orígenes permitidos separados por coma. Vacío = cualquier origen (para conectar cualquier frontend local sin configurar nada) |

`.env` está en `.gitignore` porque contiene la credencial real de Neon — nunca se sube al repositorio. `.env.example` sí se versiona como plantilla.

---

## 5. Modelo de datos (Neon, esquema compartido)

Este servicio **no crea tablas propias**: usa el esquema ya provisto por el equipo, principalmente:

- `scoring.external_data_snapshots` — fuentes alternativas (buró, servicios, wallet, e-commerce, recargas)
- `scoring.scoring_results` — score, riesgo, recomendación, SHAP, versión de modelo
- `scoring.approval_decisions` — decisión final (automática o manual)
- `audit.event_store` — event sourcing (hash chain + firma)
- `audit.credit_decision_audit` — trazabilidad regulatoria completa y firmada
- `credit.credit_applications` — lectura/actualización de estado; `applicant.applicants` — lectura para obtener `document_number`

Es **autocontenido**: si `credit.credit_applications` o el snapshot externo no existen todavía (porque `credit-application-service` / `external-data-service` de otra persona no está corriendo), este servicio genera lo que necesita por su cuenta (vía el circuit breaker simulado) y deja un rastro en `audit.event_store` (`ScoringStarted`) que además sirve de *fallback* para resolver `applicantId` / `requestedAmount` cuando la fila de `credit_applications` no existe.

---

## 6. Pipeline de scoring (inciso II)

```
evaluate(applicationId, applicantId, requestedAmount?)
  │
  ├─ 1. Busca applicant en applicant.applicants (document_number)
  ├─ 2. Audita evento "ScoringStarted"
  ├─ 3. Obtiene/crea snapshot en scoring.external_data_snapshots
  │       └─ consulta buró vía circuitBreaker.service (CLOSED/OPEN/HALF_OPEN + caché)
  │       └─ simula utility/wallet/ecommerce/topup scores
  ├─ 4. Toma el modelo ACTIVO (blue/green) y sus pesos
  ├─ 5. score = Σ(feature_i * weight_i) normalizado a 300-850
  ├─ 6. riskLevel/recommendation según umbrales
  ├─ 7. shapValues = contribución relativa de cada variable
  ├─ 8. Inserta en scoring.scoring_results
  └─ 9. Audita evento "ScoringCompleted"
```

### Fórmula de scoring

```
rawScore = credit_bureau_score   * w.credit_bureau_score
         + utility_payment_score * w.utility_payment_score
         + wallet_transaction_score * w.wallet_transaction_score
         + ecommerce_score       * w.ecommerce_score
         + mobile_topup_score    * w.mobile_topup_score

score = normalize(rawScore) → rango 300-850
```

Niveles de riesgo: `LOW` (≥700) · `MEDIUM` (600-699) · `HIGH` (<600).

### Circuit breaker del buró de crédito (inciso a del contexto adicional)

El buró nacional corre en un mainframe IBM Z con SOAP de los 2000: límite de 10 consultas/seg, latencia de 8-15s, fallas intermitentes. `circuitBreaker.service.js` implementa:

- **Estados:** `CLOSED → OPEN → HALF_OPEN → CLOSED`
- **Rate limiter** tipo *token bucket* (10 tokens/seg, configurable)
- **Caché inteligente** (10 min de TTL) por `document_number`: si el circuito está `OPEN` y hay caché, se usa (`degraded: true`); si no hay caché, se degrada a un score neutro (550) en vez de tumbar el pipeline — el NFR exige responder en <60s en el 95% de los casos, así que el scoring **nunca** debe bloquearse esperando al mainframe.
- `GET /api/scoring/circuit-breaker/status` expone el estado actual para monitoreo/demo.

Por defecto la simulación es rápida (80-480ms) para que la demo sea usable; `CREDIT_BUREAU_FORCE_SLOW=true` reproduce la latencia real de 8-15s del kata.

### Blue/Green del modelo ML (sin downtime)

`model.service.js` mantiene un registro en memoria de modelos (`model-v2-green`, `model-v2-blue`, cada uno con sus propios pesos) y un puntero al modelo `activeModel` / `standbyModel`. `POST /api/scoring/model/switch` intercambia el puntero **instantáneamente** (no hay redeploy, no hay caída de servicio) y el cambio queda auditado como evento `ModelSwitched`.

---

## 7. Motor de aprobación (inciso III)

| Condición | Decisión | Tipo |
|---|---|---|
| `monto ≤ AUTO_APPROVAL_LIMIT` y `score ≥ MIN_SCORE_APPROVAL` | `APPROVED` | `AUTOMATIC` |
| `monto > AUTO_APPROVAL_LIMIT` y `score ≥ MIN_SCORE_MANUAL_REVIEW` | `MANUAL_REVIEW` | `SYSTEM_ESCALATION` |
| `score < MIN_SCORE_MANUAL_REVIEW` | `REJECTED` | `AUTOMATIC` |
| Sin scoring o sin monto resoluble | `MANUAL_REVIEW` | `SYSTEM_ESCALATION` |
| Resuelto por un analista | `APPROVED` / `REJECTED` | `MANUAL` |

La resolución de `requestedAmount` y `applicantId` sigue esta cascada (para que el servicio funcione aunque `credit_applications` aún no tenga la fila):

1. Override explícito en el body (`requestedAmount`) — solo para el monto.
2. Fila real en `credit.credit_applications`.
3. Evento `ScoringStarted` en `audit.event_store` (siempre existe si se llamó a `evaluate` antes).

Cada decisión actualiza `credit.credit_applications.status` (best-effort, no rompe el flujo si la fila no existe) y queda firmada en `audit.credit_decision_audit` + evento en `audit.event_store`.

---

## 8. Auditoría y trazabilidad regulatoria (inciso b) — 100%

`audit.service.js` implementa un **event store encadenado por hash** (estilo blockchain ligero) + **firma digital HMAC-SHA256**:

- Cada evento (`ScoringStarted`, `ScoringCompleted`, `AutomaticApprovalCompleted`, `ManualReviewCompleted`, `ModelSwitched`) se inserta en `audit.event_store` con:
  - `hash` = SHA-256(aggregateId + eventType + eventData + previousHash)
  - `previous_hash` = hash del evento anterior del mismo `aggregate_id` (cadena verificable: si alguien altera un evento intermedio, el hash del siguiente ya no coincide)
  - `digital_signature` = HMAC-SHA256(hash, `DIGITAL_SIGNATURE_SECRET`)
- Cada decisión de crédito (automática o manual) se inserta además en `audit.credit_decision_audit` con variables de entrada, SHAP values, score final, decisión, versión de modelo y firma digital — exactamente lo que exige la Superintendencia: *"variables de entrada, pesos del modelo y decisión final, con firmas digitales del sistema"*.

`GET /api/support/audit/:applicationId` expone el event stream completo + la auditoría de decisión para una solicitud, útil para la vista de regulador/analista del frontend.

---

## 9. Referencia de endpoints

Formato de respuesta uniforme:

```jsonc
// éxito
{ "success": true, "data": { ... } }
// error
{ "success": false, "error": { "message": "...", "details": null } }
```

### Health

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio, sin dependencias |

### Scoring — `/api/scoring`

| Método | Ruta | Body / Params | Descripción |
|---|---|---|---|
| POST | `/evaluate` | `{ applicationId, applicantId, requestedAmount? }` | Corre el pipeline completo de scoring |
| GET | `/result/:applicationId` | — | Último resultado de scoring guardado |
| GET | `/explanation/:applicationId` | — | Explicación SHAP del último resultado |
| GET | `/model/current` | — | Modelo activo/standby (blue/green) |
| POST | `/model/switch` | `{ targetModel }` | Cambia el modelo activo sin downtime |
| GET | `/circuit-breaker/status` | — | Estado del circuit breaker del buró |

### Aprobación — `/api/approval`

| Método | Ruta | Body / Params | Descripción |
|---|---|---|---|
| POST | `/automatic` | `{ applicationId, requestedAmount? }` | Corre las reglas de aprobación automática |
| POST | `/manual-review` | `{ applicationId, analystId?, decision, reason }` | Decisión de un analista (`APPROVED`/`REJECTED`) |
| GET | `/decision/:applicationId` | — | Última decisión registrada |
| PATCH | `/:applicationId/analyst-decision` | `{ analystId?, decision, reason }` | Alias de `manual-review` orientado a la UI del analista |

### Soporte de integración (solo lectura) — `/api/support`

Pensados para que los frontends (`/applicant/result`, `/analyst/review`, etc.) puedan poblar listas y detalle sin esperar a que `applicant-service` / `credit-application-service` estén desplegados:

| Método | Ruta | Query | Descripción |
|---|---|---|---|
| GET | `/applications` | `?status=&applicantId=&limit=` | Lista de solicitudes con su último score |
| GET | `/applications/:applicationId` | — | Detalle: solicitud + solicitante + scoring + decisión + snapshot externo |
| GET | `/applicants` | `?userId=&limit=` | Lista de solicitantes registrados (filtrable por `user_id` de `auth.users`, útil para que el frontend resuelva el perfil del usuario logueado) |
| GET | `/audit/:applicationId` | — | Event stream + auditoría de decisión de una solicitud |

Todas las rutas validan que los identificadores sean UUID válidos y devuelven `400` con un mensaje claro si no lo son, en vez de un error 500 genérico.

---

## 10. Integración con el frontend

El frontend (`neolend-frontend`) consume este microservicio a través de un único archivo dedicado: [`src/api/scoringApi.js`](../neolend-frontend/src/api/scoringApi.js). Ese archivo:

- Apunta a `VITE_SCORING_API_URL` (`.env` del frontend), por defecto `http://localhost:3001/api`.
- Desenvuelve el formato `{ success, data }` / `{ success:false, error }` y lanza un `Error` con el mensaje del backend, para que las páginas solo necesiten `try/catch`.
- Expone una función por endpoint: `evaluateScoring`, `getScoringResult`, `getScoringExplanation`, `getCurrentModel`, `switchModel`, `getCircuitBreakerStatus`, `runAutomaticApproval`, `submitManualReview`, `getApprovalDecision`, `submitAnalystDecision`, `listApplications`, `getApplicationDetail`, `listApplicants`, `getAuditTrail`, `checkHealth`.

Páginas del frontend que ya están 100% conectadas a este servicio (sin datos simulados):

| Página | Archivo | Qué usa de este microservicio |
|---|---|---|
| Revisión manual (analista) | `src/pages/Analyst/ReviewPage.jsx` | `listApplications`, `getApplicationDetail`, `evaluateScoring`, `runAutomaticApproval`, `submitManualReview`, `getAuditTrail` |
| Explicación de scoring (analista) | `src/pages/Analyst/ScoringExplanationPage.jsx` | `listApplications`, `getScoringExplanation`, `getCurrentModel`, `switchModel`, `getCircuitBreakerStatus`, `evaluateScoring` |
| Resultado de evaluación (solicitante) | `src/pages/Applicant/ResultPage.jsx` | `listApplicants`, `listApplications`, `getApplicationDetail`, `evaluateScoring` |

`app.js` habilita CORS abierto (`origin: true` si `CORS_ORIGIN` está vacío) precisamente para que cualquier puerto de Vite/CRA pueda consumir la API sin configuración adicional durante el desarrollo.

---

## 11. Usuarios de prueba

Creados con el `auth-service` real (`Final-auth-service-applicant-service`, puerto `3003`) vía `POST /api/auth/register` — son cuentas reales en `auth.users`, no simuladas. Misma contraseña para los 6 (cámbiala en producción):

**Contraseña para todos:** `NeoLend#2026Hack`

| Email | Rol | Nombre | Notas |
|---|---|---|---|
| `dilanmamanip@gmail.com` | `SOLICITANTE` | Dilan Mamani Pamuri | Tiene perfil de solicitante real creado (`applicant.applicants`) y 2 solicitudes de crédito evaluadas de extremo a extremo — úsalo para probar `ResultPage` |
| `dilanmamanipamuri@gmail.com` | `ANALISTA` | Dilan Mamani Analista | Resolvió manualmente varias de las solicitudes del seed — úsalo para `ReviewPage` / `ScoringExplanationPage` |
| `obedpamuri@gmail.com` | `GESTOR_COBRANZA` | Obed Pamuri Cobranza | Rol de cobranza (módulo de otro equipo) |
| `dilan.mamani@ucb.edu.bo` | `REGULADOR` | Dilan Mamani Regulador | Tiene un reporte regulatorio sembrado en `audit.regulatory_reports` |
| `inversionista.demo@neolend.com` | `INVERSIONISTA` | Fondo Inversion Demo | Inventado (no se dio email real para este rol); tiene métricas de cartera sembradas |
| `comercio.demo@neolend.com` | `COMERCIO` | NeoStore Comercio Demo | Inventado (no se dio email real para este rol) |

Login real: `POST http://localhost:3003/api/auth/login` con `{ "email": "...", "password": "NeoLend#2026Hack" }`, o directamente desde `/login` en el frontend.

Los `id` (UUID) de estos usuarios están hardcodeados como referencia en `scripts/seed-demo.js` (constante `REAL`) — si los recreas con otros IDs, actualiza esa constante antes de volver a correr el seed.

---

## 12. Datos de prueba / Seed masivo

`scripts/seed-demo.js` deja la base "súper cargada" para poder probar **todo** el sistema (no solo este microservicio) de punta a punta:

```bash
# 1. Asegúrate de tener el servicio corriendo (otra terminal)
npm run dev

# 2. Corre el seed (usa fetch contra localhost:3001, no llamadas fake)
node scripts/seed-demo.js
```

Qué hace, en orden:

1. **2 solicitudes reales** para `dilanmamanip@gmail.com` (idempotente: si ya existen, las omite) — una de USD 480 (pensada para aprobación automática) y una de USD 1800 (pensada para escalar a revisión manual, resuelta por el analista real).
2. **10 solicitantes + solicitudes sintéticas** con montos, plazos y propósitos variados, cada una corrida por el **pipeline real** (`POST /api/scoring/evaluate` → `POST /api/approval/automatic` → `POST /api/approval/manual-review` cuando aplica) — nada se inserta "a mano" en `scoring_results` ni `approval_decisions`, todo pasa por el código real del servicio.
3. **Relleno idempotente de la cola del analista**: si quedan menos de 3 solicitudes en `MANUAL_REVIEW` sin resolver, crea más (montos > USD 500) hasta asegurar al menos 3 — para que `ReviewPage` nunca se vea vacío en la demo.
4. **Datos periféricos** (vía SQL directo, ya que esos microservicios no existen todavía): préstamos + desembolsos + cuotas para las solicitudes aprobadas, `fraud.fraud_checks` para cada solicitud, métricas de cartera en `investor.portfolio_metrics`, progreso en `education.user_course_progress`, notificaciones, y un reporte en `audit.regulatory_reports`.

El script es seguro de re-correr: las solicitudes reales y los inversionistas no se duplican; lo demás simplemente añade más volumen (útil si quieres "recargar" la demo).

Tras correrlo, el estado típico de la base queda así (puede variar por la aleatoriedad del scoring):

| Tabla | Filas aprox. |
|---|---|
| `applicant.applicants` | ~27 |
| `credit.credit_applications` | ~34 (18 `APPROVED`, 9 `REJECTED`, 3 `MANUAL_REVIEW`, resto en progreso) |
| `scoring.scoring_results` | ~39 |
| `scoring.approval_decisions` | ~45+ |
| `audit.event_store` | ~139 eventos encadenados y firmados |
| `audit.credit_decision_audit` | ~56 decisiones firmadas |
| `credit.loans` | ~17 |

Verificable en cualquier momento con `GET /api/support/applications` o consultando Neon directamente.

---

## 13. Flujo de demo recomendado

1. `GET /health`
2. `GET /api/support/applications` → elegir un `applicationId`/`applicantId` reales
3. `POST /api/scoring/evaluate`
4. `GET /api/scoring/result/:applicationId`
5. `GET /api/scoring/explanation/:applicationId`
6. `POST /api/approval/automatic` (monto ≤ 500 → aprobado/rechazado automático; > 500 → escalado)
7. Si quedó en `MANUAL_REVIEW`: `POST /api/approval/manual-review` (rol analista)
8. `GET /api/approval/decision/:applicationId`
9. `GET /api/support/audit/:applicationId` → mostrar la cadena de eventos firmada
10. `GET /api/scoring/model/current` → `POST /api/scoring/model/switch` → repetir `evaluate` y notar el cambio de `modelVersion` sin reiniciar el servicio
11. `GET /api/scoring/circuit-breaker/status`

La colección de Postman (`postman/NeoLend-Credit-Scoring.postman_collection.json`) automatiza este flujo completo con variables encadenadas y tests.

### Colección de Postman

Ubicada en `postman/`:

- `NeoLend-Credit-Scoring.postman_collection.json` — 33 requests en 7 carpetas:
  1. **Health**
  2. **Scoring (datos sembrados)** — evaluate/result/explanation + caso 404
  3. **Flujo Autocontenido** — genera un `applicationId` nuevo con `{{$guid}}` y prueba que scoring + aprobación + auditoría funcionan sin que exista la fila en `credit_applications` (fallback vía evento `ScoringStarted`)
  4. **Aprobación** — automática (aprobado, escalado por monto), manual (`POST` y `PATCH`), y 404
  5. **Blue/Green Model** — current → switch a blue → evaluate (verifica `modelVersion`) → switch de vuelta a green → circuit breaker status
  6. **Soporte / Integración Frontend** — listas, detalle, auditoría
  7. **Validaciones (casos negativos)** — UUID inválido, monto negativo, applicant inexistente, decisión inválida, falta `reason`, falta `targetModel`, ruta inexistente

  Cada request trae **tests automáticos** (`pm.test`) que verifican status code y forma de la respuesta — son los mismos 33 requests / 59 assertions verificados con Newman antes de entregar este servicio (0 fallos).

- `NeoLend-Local.postman_environment.json` — entorno con `baseUrl=http://localhost:3001` y los UUID reales de los datos sembrados en Neon (un solicitante con crédito ≤ 500 ya aprobado, otro con crédito > 500 en revisión manual, un analista, y un solicitante "fresco" sin solicitud creada para el flujo autocontenido).

**Cómo correrla:**

```bash
# Importar en Postman: File → Import → seleccionar ambos .json (collection + environment)
# o desde terminal con Newman:
npx newman run postman/NeoLend-Credit-Scoring.postman_collection.json \
  -e postman/NeoLend-Local.postman_environment.json
```

Con el servidor corriendo en `localhost:3001`, el run completo da **33/33 requests y 59/59 assertions en verde**.

---

## 14. Manejo de errores

`middlewares/errorHandler.js` traduce errores internos a respuestas HTTP claras:

| Código | Causa |
|---|---|
| `400` | Validación de entrada (UUID inválido, campo requerido, `decision` fuera de enum, formato de UUID en Postgres `22P02`) |
| `404` | Recurso no encontrado (ruta inexistente o sin datos para ese `applicationId`) |
| `409` | Registro duplicado (Postgres `23505`) |
| `503` | Circuito del buró abierto y sin caché disponible |
| `504` | Timeout consultando el buró de crédito |
| `500` | Error interno no clasificado (incluye el mensaje real solo si `NODE_ENV !== production`) |

---

## 15. Decisiones de diseño (resumen para el ADR del equipo)

- **Sin JWT/auth en este servicio**: se prioriza poder probarlo de forma aislada en el hackatón sin depender de que `auth-service` esté arriba. La autenticación se resuelve en el gateway/auth-service en producción.
- **Autocontenido respecto a datos externos**: si no hay snapshot de buró/servicios/wallet, este servicio los simula — no bloquea el pipeline esperando a `external-data-service`.
- **Fallback de auditoría vía event store**: cuando `credit_applications` aún no existe, `applicantId`/`requestedAmount` se recuperan del evento `ScoringStarted`, para que la aprobación funcione incluso en pruebas 100% aisladas.
- **Degradación ante fallos del buró**: tanto el circuito abierto como un fallo transitorio individual devuelven un score neutro en vez de un error 500 — el NFR de <60s end-to-end en el 95% de los casos exige que el scoring no dependa de la disponibilidad del mainframe en cada llamada.
- **CORS abierto por defecto**: para no acoplar este backend a un puerto/origen de frontend específico durante el desarrollo; restringible vía `CORS_ORIGIN`.

---

## 16. Cobertura completa del kata — trazabilidad por requerimiento

Matriz de qué requerimiento del "Kata Arquitectónico — Hackatón Final" cubre **este** microservicio, y en qué archivo exacto está implementado. Lo que no es responsabilidad de scoring/aprobación se marca como tal (lo cubre otro repo del equipo).

### Requerimientos funcionales

| # | Requerimiento del kata | ¿Cubierto aquí? | Archivo / mecanismo |
|---|---|---|---|
| 1 | Solicitud de crédito desde app móvil en <3 min, solo subiendo documento | No (applicant-service / credit-application-service) | — |
| 2 | Motor de score en tiempo real con buró, servicios públicos, wallets y e-commerce, puntaje explicable (SHAP) | **Sí** | `src/services/scoring.service.js` (pipeline), `src/services/shap.service.js` (explicación), `src/services/circuitBreaker.service.js` (consumo del buró) |
| 3 | Aprobación automática ≤ USD 500 sin intervención humana en <90s; mayores escalan a revisión manual con evidencia precargada | **Sí** | `src/services/approval.service.js` (`runAutomaticApproval`), umbral `AUTO_APPROVAL_LIMIT` en `.env`; evidencia precargada = `getApplicationDetail` en `src/services/support.service.js` (incluye scoring + snapshot externo en una sola llamada) |
| 4 | Desembolso multi-canal (wallets, bancos, corresponsales) | No (disbursement-service) | — |
| 5 | Cobranza: recordatorios, acuerdos de pago, reestructuración, reporte a burós | No (collection-service) | — |
| 6 | Portal de inversionistas en tiempo real (TIR, morosidad, flujo de caja, exposición) | No (investor-service) | — |
| 7 | Detección de fraude en tiempo real (biometría, identidades robadas) | No (fraud-service) | — |
| 8 | Educación financiera gamificada con bonificación de score/tasa | No (education-service) | — |

### Requerimientos no funcionales

| # | Requerimiento | ¿Cubierto aquí? | Archivo / mecanismo |
|---|---|---|---|
| NF1 | Pipeline de scoring: 95% de solicitudes en <60s extremo a extremo | **Sí** | Circuit breaker con timeout `CREDIT_BUREAU_TIMEOUT_MS` + degradación a score neutro (`scoring.service.js`, función `getOrCreateExternalDataSnapshot`) garantiza que el pipeline nunca espera indefinidamente al mainframe; `processingTimeMs` se mide y persiste en cada `scoring_results` |
| NF2 | Cifrado AES-256 de datos financieros | Parcial / infraestructura | Cifrado en tránsito vía `sslmode=require` de Neon; cifrado en reposo es responsabilidad de Neon (gestionado). No se re-implementa AES a nivel aplicación en este servicio |
| NF2 | Logs inmutables de decisiones de crédito, auditables por 10 años | **Sí** | `audit.event_store` (hash chain) + `audit.credit_decision_audit` (firma HMAC), ambos en `src/services/audit.service.js`. Sin `UPDATE`/`DELETE` en el código — solo `INSERT` |
| NF2 | Reportes automáticos al ente regulador | Parcial | `audit.regulatory_reports` sembrado (`scripts/seed-demo.js`, función `seedRegulatoryReport`); el endpoint de generación automática recurrente es responsabilidad de audit-service (otro repo) |
| NF3 | Activo-activo en dos regiones | Diseño documentado, no implementado en código | Ver diagrama de despliegue del documento de arquitectura del equipo; este servicio es *stateless* (toda persistencia vive en Neon) por lo que es horizontalmente escalable/replicable sin cambios de código — requisito de diseño, no de runtime de un solo microservicio |
| NF4 | Decisiones de IA explicables y no discriminatorias (auditoría de sesgo mensual) | Parcial | Explicabilidad: **sí**, vía SHAP simulado (`shap.service.js`) visible en `GET /api/scoring/explanation/:id`. Auditoría de sesgo demográfico automatizada: no implementada (requeriría datos demográficos que no están en el dominio de este servicio) |

### Contexto adicional

| Inciso | Requerimiento | ¿Cubierto aquí? | Archivo / mecanismo |
|---|---|---|---|
| a) | Buró de crédito en mainframe IBM Z, SOAP de los 2000, límite 10 req/s, latencia 8-15s, circuit breaker + caché inteligente | **Sí** | `src/services/circuitBreaker.service.js` completo: estados `CLOSED/OPEN/HALF_OPEN`, rate limiter *token bucket*, caché con TTL de 10 min, simulación de latencia/fallos configurable (`CREDIT_BUREAU_FORCE_SLOW`, `CREDIT_BUREAU_FAILURE_RATE`) |
| b) | Trazabilidad completa auditada mensualmente por la Superintendencia: variables de entrada, pesos del modelo, decisión final, firmas digitales — **MVP 100%** | **Sí, es el foco de este repo** | `src/services/audit.service.js` (`recordEvent`, `recordCreditDecisionAudit`); ver sección 8 de este README |
| c) | Datos biométricos nunca salen del país (data residency) | No aplica a este servicio | Este servicio no procesa biometría (eso es fraud-service); no hay llamadas a servicios cloud externos de ningún tipo aquí — todo el procesamiento es local al proceso Node |

### MVP / Ponderación de la rúbrica

| MVP | Incisos | Ponderación | Aporte de este repo |
|---|---|---|---|
| 1 | I, II, III — solicitud, scoring, aprobación automática | 60% | **Scoring (inciso II) y aprobación (inciso III) completos.** La solicitud (inciso I) la cubre `applicant-service`/`credit-application-service` |
| 2 | IV, V — desembolso y cobranza | 70% | No aplica a este repo |
| 3 | VI, VII, VIII — inversionistas, fraude, educación | 80% | No aplica a este repo |
| 4 | Inciso b) — trazabilidad auditada con firma digital | 100% | **Implementado íntegramente en este repo** (sección 8 + `audit.service.js`) |

### Arquitectura obligatoria (requisitos transversales del kata)

| Requisito transversal | ¿Cumplido? | Evidencia |
|---|---|---|
| Arquitectura de microservicios | Sí | Este repo es un microservicio independiente con su propia responsabilidad (scoring + aprobación), desplegable y probable de forma aislada (ver sección 1 y Postman) |
| Motor de scoring como microservicio independiente | Sí | Todo este repositorio |
| Blue/Green deployment del modelo ML sin downtime | Sí | `src/services/model.service.js` + `POST /api/scoring/model/switch`; probado en vivo en la sección 13 (Postman carpeta 5) |
| Cada microservicio gestiona su propia base de datos | Parcial (por diseño del equipo) | Se usa un único Neon compartido con **schemas separados por dominio** (`scoring`, `credit`, `audit`, etc.) en vez de bases físicamente distintas — decisión de equipo documentada para simplificar el hackatón; este servicio solo escribe en sus propios schemas (`scoring.*`) y en `audit.*`, y solo lee (nunca escribe esquema) de `credit.*`/`applicant.*` |
| CQRS + Event Sourcing para trazabilidad regulatoria | Sí | `audit.event_store` es el *event store* (escritura por evento, nunca se actualiza una fila); `scoring.scoring_results` / `scoring.approval_decisions` actúan como el lado de *lectura* (proyección del último estado) — ver sección 8 |
| Repositorio de GitHub del grupo | — | Este repo: `neolend-credit-scoring-service` (uno de los 6 repos del grupo, ver el documento de arquitectura general para el listado completo) |
