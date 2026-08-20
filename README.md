# BUNQSY Finance

**An always-on AI financial guardian for bunq users.**

Built for bunq Hackathon 7.0. BUNQSY doesn't wait for prompts — it monitors your accounts in real time, detects risk and behavioural patterns using a multi-agent Risk Oracle, acts before damage is done, and consolidates knowledge while you sleep via Dream Mode.

---

## What it does

| Capability | Detail |
|---|---|
| **Live account monitoring** | Heartbeat loop syncs transactions every 30 s; multi-account aware |
| **BUNQSY Health Score** | 0–100 composite score (balance, velocity, goals, upcoming obligations) |
| **Risk Oracle** | 7 concurrent AI sub-agents vote on risk; interventions fire when threshold is crossed |
| **Proactive interventions** | Voice narration + UI card; plan-gated card freezes, transfers, draft cancellations |
| **Voice interface** | ElevenLabs STT → Claude NLU → execution plan → TTS confirmation |
| **Dream Mode** | Nightly pattern analysis in an isolated worker; generates DNA card + 3 suggestions |
| **Cards management** | Live bunq card list with freeze/unfreeze via PLAN → CONFIRM → EXECUTE gateway |
| **30-day forecast** | Day-by-day balance projection accounting for salary, rent, subscriptions |
| **Receipt scanner** | Photo → Claude Sonnet extraction → transaction matching → spending insight |
| **Bookkeeping** | Auto-categorised double-entry journal, P&L, VAT tracker, CSV/MT940 export |
| **Guardian Feed** | Chronological intervention history with inline approve/block actions |

---

## Architecture

TypeScript monorepo managed with Turborepo:

```
packages/
  daemon/     — Fastify 5 backend: bunq API, heartbeat, oracle, AI, voice, bookkeeping
  frontend/   — React 18 + Vite 5 dashboard
  shared/     — Zod schemas and TypeScript types shared across packages
scripts/      — Validation, seeding, and demo utilities
```

### Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20+, Fastify 5, TypeScript ESM |
| Database | SQLite (better-sqlite3, WAL mode), sqlite-vec for embeddings |
| Frontend | React 18, Vite 5, Recharts |
| bunq API | REST v1, RSA-2048 + SHA-256 request signing |
| AI | Anthropic Claude (Haiku 4.5 oracle/narration, Sonnet 4.5 receipts/bookkeeping) |
| Voice | ElevenLabs scribe_v1 (STT), eleven_turbo_v2_5 (TTS) |
| Embeddings | Ollama + nomic-embed-text (local, optional) |
| Real-time | WebSocket (`@fastify/websocket`) |

---

## Core systems

### Heartbeat loop
Runs every 30 s (configurable via `HEARTBEAT_INTERVAL_MS`):
1. Syncs all monetary accounts and new transactions into SQLite
2. Builds `AccountSummary` for every active account (multi-account intelligence)
3. Computes the BUNQSY Health Score from four weighted components
4. Runs the Risk Oracle — 7 concurrent sub-agents each casting a typed `OracleVote`
5. Dispatches an intervention if the oracle says to act
6. Appends an append-only tick log and score log entry

### BUNQSY Health Score

| Component | Weight | Measures |
|---|---|---|
| Balance | 35% | Runway months vs estimated monthly spend (or salary ratio) |
| Velocity | 25% | Today's spend vs 30-day average daily spend |
| Goals | 25% | Savings goal progress, time-weighted against target dates |
| Upcoming | 15% | Proximity to rent deadline; subscription coverage ratio |

Weights tunable via `SCORE_WEIGHT_*` env vars.

### Risk Oracle — 7 sub-agents

All agents run concurrently. Each has a hard budget of 800 input + 200 output tokens. They cannot call each other and cannot execute writes. They return a typed `OracleVote`.

| Agent | Detects |
|---|---|
| `balance-sentinel` | Low balance, overdraft risk, unusual spend on joint accounts |
| `velocity-analyzer` | Intraday spend spikes (1.5× – 4× historical average) |
| `fraud-shadow` | Anomalous transaction patterns (LLM-backed) |
| `subscription-watcher` | New recurring charges, cost creep, salary ratio |
| `rent-proximity-guard` | Upcoming rent deadline vs current balance |
| `pattern-matcher` | Vector (Ollama) or SQL matching against learned patterns |
| `jar-optimizer` | Savings jar rebalancing opportunities |

An intervention fires when `shouldIntervene = true` on any vote **and** aggregate risk ≥ 50.

### Single write gateway
**`packages/daemon/src/bunq/execute.ts` is the only file permitted to make POST/PUT/DELETE requests to the bunq API.** All writes flow through `createExecutionPlan → confirmPlan → executePlan`. Every other module is read-only with respect to bunq. Explicit user confirmation (UI tap or voice "yes") is required before `executePlan` is called.

Supported plan step types: `PAYMENT`, `SAVINGS_TRANSFER`, `DRAFT_PAYMENT`, `CANCEL_DRAFT`, `SANDBOX_FUND`, `CARD_FREEZE`, `CARD_UNFREEZE`, `CREATE_SAVINGS_GOAL`.

Every step is validated twice — at plan creation and again before execution — against a per-type schema (IBAN shape, integer ids, currency allow-list, `MAX_PAYMENT_EUR` ceiling, ≤ 10 steps). **Outbound payments are denied by default** (`VOICE_PAYMENTS_ENABLED=false`): `PAYMENT`/`DRAFT_PAYMENT` can only originate from the LLM planner, whose input is a transcript, so third-party money movement is an explicit opt-in rather than a confirmation click. See [SECURITY.md](SECURITY.md).

### Dream Mode
Runs nightly at 02:00 in the user's configured timezone. Executes in a **forked child process** with a 10-minute kill timeout. The worker analyses transaction history, updates pattern confidence scores, generates a DNA card (financial personality snapshot), and produces three actionable suggestions. The worker cannot import `execute.ts`.

### Voice interface
- **STT**: ElevenLabs `scribe_v1` — audio upload via `POST /api/voice`
- **NLU**: Claude Haiku converts transcript to a typed `ExecutionPlan`
- **TTS**: ElevenLabs `eleven_turbo_v2_5` via `POST /api/voice/speak`
- Voice ID configurable via `ELEVENLABS_VOICE_ID` (default: Sarah)

### Cards management
`GET /api/cards` returns live bunq card data (physical + virtual Mastercards). Freeze and unfreeze actions use the PLAN → CONFIRM → EXECUTE gateway with a Claude-narrated confirmation panel. In sandbox mode, realistic demo cards are injected automatically with the real account holder name. `GET /api/bunq-goals` returns native bunq savings goals with progress.

### Bookkeeping
Auto-categorises every synced transaction into a double-entry journal using Claude Haiku. Produces P&L by date range, tax summary by year, VAT period tracking (Dutch quarterly), and exports to CSV and MT940 bank statement format. A review queue surfaces low-confidence categorisations for manual approval.

### 30-day forecast
`GET /api/forecast` generates a day-by-day balance projection. Results cached 6 hours. The engine factors in salary, rent, recurring subscriptions, and impulse spend derived from pattern confidence scores.

### Receipt scanner
`POST /api/receipt` accepts a photo. Claude Sonnet extracts line items, a verifier checks totals within ±2%, a categoriser matches the receipt to a stored transaction, and generates a spending insight.

---

## Frontend dashboard

Five tabs: **Dashboard · Insights · Cards · Bookkeeping · Voice**

### Dashboard
- BUNQSY Health Score rainbow ring with component breakdown bars and trend
- Account tiles (primary, savings, goals) with balances and progress bars
- Quick action buttons (Send, Receive, New)
- Oracle Voting Panel — live sub-agent votes with confidence bars and rationale
- All Accounts panel — multi-account live view with classification badges
- 30-Day Forecast chart with event markers
- Spending This Month — category bars
- Recent Transactions
- InterventionCard overlay (glassmorphism, severity colour-coded)
- FraudBlock full-screen modal for fraud/freeze interventions

### Insights
- Dream Hero Card with "Saved in Sleep" metric
- Spending bars + goal ring
- KPI tiles (saving rate, burn rate) with coloured left-border accents
- Security Posture card — mini health ring + Single Write Gateway status
- Connected Accounts — live account list with ACTIVE/RE-AUTH badges
- Active Agents dashboard — 7 agents with live confidence % and coloured progress bars
- Guardian Feed — chronological intervention history with inline Block/Approve actions
- AI Insight cards with severity-coloured left borders
- Upcoming Expenses and Take Action cards

### Cards
- Live bunq card faces (physical + virtual) with rainbow top stripe, chip, masked PAN
- SANDBOX badge on demo cards
- Freeze/unfreeze with inline PLAN → CONFIRM → EXECUTE narration panel
- bunq native Savings Goals with progress bars

### Bookkeeping
- Status tile (total transactions, journal entries, uncategorised, pending review)
- Review queue with category override
- P&L report, VAT tracker, CSV and MT940 export

### Voice
- VoiceOrb — tap to record, ElevenLabs STT, Claude NLU, spoken confirmation

---

## API reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/score` | Latest BUNQSY score with component breakdown |
| `GET` | `/api/accounts` | Multi-account summaries |
| `GET` | `/api/interventions` | Recent intervention history (last 20) |
| `POST` | `/api/confirm/:planId` | Confirm + execute, or cancel a plan |
| `POST` | `/api/dismiss/:interventionId` | Dismiss an active intervention |
| `GET` | `/api/forecast` | 30-day balance forecast (6 h cache) |
| `POST` | `/api/voice` | Upload audio → transcribe → plan |
| `POST` | `/api/voice/speak` | Text → ElevenLabs TTS audio |
| `POST` | `/api/receipt` | Upload receipt image → extract + categorise |
| `POST` | `/api/dream/trigger` | Manually trigger Dream Mode |
| `GET` | `/api/dream/latest` | Latest completed Dream session |
| `GET` | `/api/cards` | Live bunq card list |
| `POST` | `/api/cards/:id/freeze` | Create CARD_FREEZE execution plan |
| `POST` | `/api/cards/:id/unfreeze` | Create CARD_UNFREEZE execution plan |
| `GET` | `/api/bunq-goals` | Native bunq savings goals |
| `GET` | `/api/bookkeeping/status` | Transaction and journal entry counts |
| `GET` | `/api/bookkeeping/review-queue` | Low-confidence entries pending review |
| `POST` | `/api/bookkeeping/review-queue/:id/approve` | Approve / override category |
| `POST` | `/api/bookkeeping/review-queue/bulk-approve` | Bulk approve all pending |
| `GET` | `/api/bookkeeping/pl` | P&L for a date range |
| `GET` | `/api/bookkeeping/tax-summary` | Tax summary by year |
| `GET` | `/api/bookkeeping/vat` | VAT periods |
| `GET` | `/api/bookkeeping/export/csv` | CSV export |
| `GET` | `/api/bookkeeping/export/mt940` | MT940 bank statement export |
| `POST` | `/api/webhook` | bunq event webhook receiver |
| `POST` | `/api/demo/reset` | Wipe and re-seed demo data (sandbox-only 403 in prod) |
| `POST` | `/api/demo/salary` | Simulate salary-in transaction |
| `POST` | `/api/demo/fraud` | Simulate fraud transaction |
| `GET` | `/api/health` | Liveness probe: `status, uptime, lastTick, bunq: live|offline` |
| `WS` | `/ws` | Real-time events (`score_update`, `intervention`, `oracle_vote`, `tick`, `bookkeeping_update`, `dream_complete`) |

---

## Getting started

### Which URL do I open?

| URL | What it is | When to use it |
|---|---|---|
| `http://localhost:5173` | **Main dashboard** (`packages/frontend`) — full BUNQSY app (score, oracle, interventions, bookkeeping) | **Always** — this is the demo |
| `https://knarayanareddy.github.io/Bunqsy/` | **Static marketing site** (`docs/`) — pre-rendered landing (non-interactive) | Judges landing page only |
| `mock-unzip/` (run `npm run dev` inside) | **Standalone fallback** — UI without daemon (seed data only) | When `better-sqlite3` won’t compile |

### Prerequisites
- Node.js 20+
- bunq sandbox API key — [bunq.com/en/developer](https://www.bunq.com/en/developer)
- Anthropic API key
- ElevenLabs API key (voice features)
- Ollama running locally (optional — vector pattern matching)

### Setup

```bash
# 1. Clone and install
git clone <repo-url>
cd KairosFinance
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in BUNQ_API_KEY, ANTHROPIC_API_KEY, ELEVENLABS_API_KEY

# 3. Validate bunq sandbox connection (required before anything else)
npx tsx scripts/validate-phase-0.ts

# 4. Launch
bash scripts/start-demo.sh
```

The start script validates `.env`, kills stale processes on ports 3001/5173, starts the daemon, waits for `/api/score` to respond, starts Vite, and opens `http://localhost:5173`.

### Manual start

```bash
# Terminal 1 — daemon (auto-reloads on save)
cd packages/daemon && npm run dev

# Terminal 2 — frontend
cd packages/frontend && npm run dev
```

### Pre-demo checklist

```bash
npx tsx scripts/checklist.ts
```

Checks env vars, critical files, SQLite tables, RSA signing round-trip, live daemon health, and script inventory.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BUNQ_ENV` | Yes | `sandbox` | `sandbox` or `production` |
| `BUNQ_API_KEY` | Yes | — | bunq API key |
| `BUNQ_SANDBOX_URL` | Yes | — | `https://public-api.sandbox.bunq.com/v1` |
| `BUNQ_PRODUCTION_URL` | No | — | `https://api.bunq.com/v1` |
| `BUNQ_DEVICE_DESCRIPTION` | No | `BunqsyFinance-Dev` | Device label in bunq |
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `ELEVENLABS_API_KEY` | No | — | Required for voice features |
| `ELEVENLABS_VOICE_ID` | No | Sarah | TTS voice override |
| `DB_PATH` | No | `./bunqsy.db` | SQLite database path |
| `PORT` | No | `3001` | Daemon HTTP/WS port |
| `HEARTBEAT_INTERVAL_MS` | No | `30000` | Tick interval in ms (30 s, CBS proactivity) |
| `OLLAMA_URL` | No | `http://localhost:11434` | Ollama for pattern embeddings |
| `OLLAMA_EMBED_MODEL` | No | `nomic-embed-text` | Ollama embed model |
| `WEBHOOK_PUBLIC_URL` | No | — | Public URL for bunq webhook push |
| `FRONTEND_URL` | No | — | Allowed CORS origin in production (e.g. `https://app.bunqsy.com`) |
| `BUNQ_OFFLINE_MODE` | No | `false` | `true` → daemon runs on seed data when sandbox is down (demo resilience) |
| `SCORE_WEIGHT_BALANCE` | No | `0.35` | Balance component weight |
| `SCORE_WEIGHT_VELOCITY` | No | `0.25` | Velocity component weight |
| `SCORE_WEIGHT_GOALS` | No | `0.25` | Goals component weight |
| `SCORE_WEIGHT_UPCOMING` | No | `0.15` | Upcoming obligations weight |

---

## Database schema

SQLite WAL mode. 14 tables; append-only where noted.

| Table | Purpose |
|---|---|
| `sessions` | bunq session tokens and RSA key pairs |
| `transactions` | Cached bunq payments (upsert on sync) |
| `patterns` | Learned behavioural patterns with confidence scores |
| `user_profile` | Singleton: name, salary, rent, timezone, voice settings |
| `goals` | Savings goals with target amounts and jar links |
| `interventions` | Append-only intervention history |
| `execution_plans` | Append-only write plans (PENDING → CONFIRMED → EXECUTED) |
| `execution_step_results` | Append-only per-step bunq API results |
| `tick_log` | Append-only heartbeat history |
| `score_log` | Append-only score history with component breakdown |
| `journal_entries` | Double-entry bookkeeping ledger |
| `vat_periods` | Dutch quarterly VAT tracking |
| `categorization_corrections` | Feedback loop for categoriser improvement |
| `forecast_cache` | Single mutable row — current 30-day forecast |
| `pattern_embeddings` | sqlite-vec virtual table (optional) |

---

## Security

The daemon holds a bunq session key and can move money, so it is treated as a
privileged local service. Full threat model, control inventory and production
checklist: **[SECURITY.md](SECURITY.md)**.

The short version for running it locally:

```bash
npm run dev            # daemon generates .bunqsy-token (0600) on first boot
```

- The daemon binds `127.0.0.1` by default. Set `HOST` to expose it, and set
  `BUNQSY_API_TOKEN` when you do.
- Every endpoint except `/api/health` and `/api/webhook` needs that token. The
  Vite dev proxy injects it server-side, so **the browser never holds it** —
  nothing to steal via XSS, nothing to replay from another page.
- Requests from a browser origin that is not allow-listed are refused (all
  methods, WebSocket upgrades included), which is what stops another tab from
  driving your guardian.
- `npm test` runs a 50-check security suite; `npm audit` should report 0.

If you cloned this repo before the hardening pass, **rotate your bunq API key** —
a committed SQLite WAL file contained the signing key. SECURITY.md has the steps.

## Constitutional rules

Enforced architecturally — cannot be overridden at runtime:

1. **Plan-before-act** — No bunq write without a confirmed `ExecutionPlan` and explicit user approval
2. **Single write gateway** — Only `execute.ts` makes POST/PUT/DELETE to bunq
3. **Bounded sub-agents** — 800 input + 200 output token hard budget per oracle agent; no agent-to-agent calls
4. **Append-only logs** — `tick_log`, `score_log`, `interventions`, `execution_plans` are INSERT-only
5. **Strict TypeScript** — No `any`; all external data validated with Zod before use
6. **Worker isolation** — Dream Mode runs in a forked process with a 10-min kill timeout; cannot import `execute.ts`
7. **Explainability** — Every intervention card includes a plain-English Claude narration

---

## Scripts

| Command | Purpose |
|---|---|
| `bash scripts/start-demo.sh` | One-command launch (daemon + frontend) |
| `npx tsx scripts/checklist.ts` | Pre-demo validation |
| `npx tsx scripts/validate-phase-0.ts` | Confirm bunq sandbox session |
| `npx tsx scripts/reset-demo.ts` | Wipe database for a clean demo |
| `npx tsx scripts/seed-demo.ts` | Seed realistic transaction history |

---

## bunq integration

- **Authentication**: 3-step protocol — installation (RSA key exchange) → device-server → session creation
- **Session persistence**: Sessions stored in SQLite; restored on restart with a 5-minute expiry buffer
- **Request signing**: Every API call signed with RSA-2048 + SHA-256 per bunq spec
- **Webhook push**: Registers PAYMENT + MUTATION notification filters when `WEBHOOK_PUBLIC_URL` is set
- **Cards API**: Live card data with freeze/unfreeze write support
- **Savings Goals API**: Native bunq goals fetched per monetary account
- **Sandbox demo**: When `BUNQ_ENV=sandbox` and no cards are provisioned, realistic demo cards are injected using the real account holder name
- **Environment selection**: All endpoint logic driven by `BUNQ_ENV` — no hardcoded assumptions

To switch to production: set `BUNQ_ENV=production` with a production `BUNQ_API_KEY`.

---

*bunq Hackathon 7.0 · BUNQSY Finance*
