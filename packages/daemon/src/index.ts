import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../.env') });
import Fastify from 'fastify';
import { getDb, closeDb } from './memory/db.js';
import { createSession, refreshSessionIfNeeded } from './bunq/auth.js';
import { BunqClient } from './bunq/client.js';
import { createOracle } from './oracle/index.js';
import { dispatchIntervention } from './intervention/engine.js';
import { startHeartbeatLoop, runTick } from './heartbeat/loop.js';
import multipart from '@fastify/multipart';
import { wsEmit, registerWsRoute } from './routes/ws.js';
import { registerApiRoutes } from './routes/api.js';
import { registerVoiceRoute } from './routes/voice.js';
import { registerReceiptRoute } from './routes/receipt.js';
import { registerDreamRoutes } from './routes/dream.js';
import { registerForecastRoute } from './routes/forecast.js';
import { registerDemoRoute } from './routes/demo.js';
import { registerBookkeepingRoutes } from './routes/bookkeeping.js';
import { scheduleDreamMode } from './dream/scheduler.js';
import { triggerDream } from './dream/trigger.js';
import type { SessionRow, BUNQSYScore, InterventionPayload, OracleVerdict, ScoreDeltaExplainPayload } from '@bunqsy/shared';
import type { BunqSession } from './bunq/auth.js';
import type { RecallSnapshot } from './heartbeat/recall.js';
import { setAccountSummaries, setLastScore } from './state.js';
import { registerNotificationFilter } from './bunq/execute.js';
import { registerSecurity } from './security/plugin.js';
import { getApiToken, tokenFingerprint, tokenLocationHint } from './security/token.js';
import { allowedOrigins } from './security/origin.js';
import { assertSafeConfig } from './security/config-check.js';

// ─── Session persistence helpers ─────────────────────────────────────────────

function loadSessionFromDb(): BunqSession | null {
  const db  = getDb();
  const row = db
    .prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1`)
    .get() as SessionRow | undefined;

  if (!row) return null;

  const expiresAt = new Date(row.expires_at);
  // Discard sessions that expire within the next 5 minutes
  if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) return null;

  return {
    installationToken: row.installation_token,
    sessionToken:      row.session_token,
    userId:            row.user_id,
    keyPair:           { privateKeyPem: row.private_key_pem, publicKeyPem: row.public_key_pem },
    expiresAt,
    serverPublicKey:   row.server_public_key,
  };
}

function storeSession(session: BunqSession): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO sessions
      (installation_token, session_token, user_id, public_key_pem, private_key_pem,
       server_public_key, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.installationToken,
    session.sessionToken,
    session.userId,
    session.keyPair.publicKeyPem,
    session.keyPair.privateKeyPem,
    session.serverPublicKey,
    session.expiresAt.toISOString(),
  );
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // Fail fast on an unsafe deployment rather than discovering it in production.
  assertSafeConfig();

  const port = parseInt(process.env['PORT'] ?? '3001', 10);

  // ── Database ───────────────────────────────────────────────────────────────
  const db = getDb();
  console.log('[bunqsy] Database ready');

  // ── bunq session ───────────────────────────────────────────────────────────
  let session = loadSessionFromDb();

  if (!session) {
    const apiKey = process.env['BUNQ_API_KEY'];
    if (!apiKey) throw new Error('BUNQ_API_KEY is not set in environment');

    console.log('[bunqsy] Creating new bunq session...');
    session = await createSession(apiKey);
    storeSession(session);
    console.log(`[bunqsy] Session created for userId=${session.userId}`);
  } else {
    console.log(`[bunqsy] Restored session for userId=${session.userId}`);
    session = await refreshSessionIfNeeded(session);
  }

  // ── Fastify ────────────────────────────────────────────────────────────────
  const fastify = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'warn' },
    // X-Forwarded-For is attacker-controlled unless a proxy we own rewrites it.
    // The webhook IP allow-list depends on req.ip, so this stays off by default.
    trustProxy: process.env['TRUST_PROXY'] === 'true',
    // 1 MB is generous for bunq notifications; multipart has its own limit.
    bodyLimit: 1_048_576,
    disableRequestLogging: true,
  });

  // Auth, CSRF, rate limiting, security headers and the error handler —
  // registered before any route so nothing can be added unguarded later.
  registerSecurity(fastify);

  // CORS — required because frontend (5173) and daemon (3001) are different origins.
  // Bunq audit fix: without this, hard reloads / prod deployments 403.
  // Production origin is allow-listed via FRONTEND_URL / WEBHOOK_PUBLIC_URL; fallback to true only if neither is set (warn).
  const prodOrigins = [
    process.env.FRONTEND_URL,
    process.env.WEBHOOK_PUBLIC_URL,
  ].filter(Boolean) as string[];
  if (process.env.BUNQ_ENV === 'production' && prodOrigins.length === 0) {
    console.warn('[bunqsy] BUNQ_ENV=production but no FRONTEND_URL/WEBHOOK_PUBLIC_URL set — CORS will allow all origins (not recommended)');
  }
  await fastify.register((await import('@fastify/cors')).default, {
    origin: process.env.BUNQ_ENV === 'sandbox'
      ? ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173']
      : (prodOrigins.length > 0 ? prodOrigins : true),
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Register multipart once at the top level — shared by voice + receipt routes
  // Claude Vision caps images around 5 MB base64; 8 MB raw is already generous
  // and keeps a single upload from pinning memory on a laptop-sized daemon.
  await fastify.register(multipart, {
    limits: {
      fileSize:  8 * 1024 * 1024,
      files:     1,
      fields:    10,
      fieldSize: 8 * 1024,
      parts:     15,
    },
  });

  let activeAID = 1;
  let webhookRegistered = false;
  const webhookPublicUrl = process.env['WEBHOOK_PUBLIC_URL'];

  const client  = new BunqClient(session);
  const oracle  = createOracle(db, wsEmit);
  const heartbeatDeps = {
    client,
    runOracle: oracle,
    dispatchIntervention: (verdict: OracleVerdict, snapshot: RecallSnapshot) =>
      dispatchIntervention(verdict, snapshot, db),
    onScore:        (score: BUNQSYScore)          => { setLastScore(score); wsEmit({ type: 'score_update', payload: score }); },
    onScoreDelta:   (payload: ScoreDeltaExplainPayload) => { wsEmit({ type: 'score_delta_explain', payload }); },
    onIntervention: (payload: InterventionPayload) => { wsEmit({ type: 'intervention', payload }); },
    onTickRecord:   (snapshot: RecallSnapshot)     => {
      activeAID = snapshot.primaryAccountId;
      setAccountSummaries(snapshot.accountSummaries ?? []);
      // Register webhook once we know the real account ID from the first tick
      if (webhookPublicUrl && !webhookRegistered) {
        webhookRegistered = true;
        const callbackUrl = `${webhookPublicUrl.replace(/\/$/, '')}/api/webhook`;
        registerNotificationFilter(session.userId, activeAID, callbackUrl)
          .catch((err: Error) => console.warn('[bunqsy] Webhook registration failed (non-fatal):', err.message));
      }
    },
    onBookkeepingUpdate: (msg: import('@bunqsy/shared').WSMessage) => { wsEmit(msg); },
    onError:        (err: Error) => { console.error('[heartbeat]', err.message); },
  };

  await registerWsRoute(fastify);
  await registerApiRoutes(fastify, () => runTick(heartbeatDeps), client);
  await registerVoiceRoute(fastify, () => runTick(heartbeatDeps), () => activeAID);
  await registerReceiptRoute(fastify);
  await registerDreamRoutes(fastify);
  await registerForecastRoute(fastify);
  await registerDemoRoute(fastify, () => runTick(heartbeatDeps), () => activeAID);
  await registerBookkeepingRoutes(fastify, () => {
    // Try to get the primary account IBAN from the session
    const row = db.prepare(`SELECT counterparty_iban FROM transactions WHERE counterparty_iban IS NOT NULL LIMIT 1`).get() as { counterparty_iban?: string } | undefined;
    return row?.counterparty_iban ?? 'NL00BUNQ0000000000';
  });

  // ── Listen ─────────────────────────────────────────────────────────────────
  // Loopback by default: this process holds a bank session key and can move
  // money. Binding 0.0.0.0 exposes it to every device on the network (and to
  // any tunnel started by `npm run demo`), so it must be opted into explicitly.
  const host = process.env['HOST'] ?? '127.0.0.1';
  await fastify.listen({ port, host });
  console.log(`[bunqsy] Server listening on http://${host}:${port}`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.warn(`[bunqsy] ⚠ Bound to ${host} — the daemon is reachable off-box. Ensure BUNQSY_API_TOKEN is set and the port is firewalled.`);
  }
  console.log(`[bunqsy] API token ${tokenFingerprint(getApiToken())} — source: ${tokenLocationHint()}`);
  console.log(`[bunqsy] Allowed browser origins: ${allowedOrigins().join(', ') || '(none — set ALLOWED_ORIGINS)'}`);

  if (!webhookPublicUrl) {
    console.log('[bunqsy] WEBHOOK_PUBLIC_URL not set — webhook push disabled, polling only');
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  const intervalMs = parseInt(process.env['HEARTBEAT_INTERVAL_MS'] ?? '30000', 10);

  const stopLoop = startHeartbeatLoop(heartbeatDeps, intervalMs);

  console.log(`[bunqsy] Heartbeat started (interval=${intervalMs}ms)`);

  // ── Dream Mode scheduler ───────────────────────────────────────────────────
  const profileRow = db
    .prepare(`SELECT timezone FROM user_profile WHERE id = 1`)
    .get() as { timezone: string } | undefined;
  const timezone = profileRow?.timezone ?? 'Europe/Amsterdam';

  const dreamTask = scheduleDreamMode(
    () => { void triggerDream(db, wsEmit, 'scheduled'); },
    timezone,
  );
  console.log(`[bunqsy] Dream Mode scheduled at 02:00 ${timezone}`);

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = (code = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[bunqsy] Shutting down...');
    stopLoop();
    dreamTask.stop();

    // Never hang a supervisor waiting on an in-flight bunq call.
    const force = setTimeout(() => process.exit(code), 5_000);
    force.unref();

    void fastify.close()
      .catch(() => { /* closing anyway */ })
      .finally(() => {
        try { closeDb(); } catch { /* ignore */ }
        process.exit(code);
      });
  };

  process.on('SIGINT',  () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  // A rejected promise anywhere in the heartbeat, oracle or dream path would
  // otherwise take the whole guardian down silently mid-demo.
  process.on('unhandledRejection', (reason) => {
    console.error('[bunqsy] Unhandled rejection:', reason instanceof Error ? reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    // An unknown-state process must not keep signing bank requests.
    console.error('[bunqsy] Uncaught exception — shutting down:', err.message);
    shutdown(1);
  });
}

boot().catch((err: unknown) => {
  console.error('[bunqsy] Fatal boot error:', err);
  process.exit(1);
});
