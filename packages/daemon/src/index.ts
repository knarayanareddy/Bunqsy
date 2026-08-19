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
  const fastify = Fastify({ logger: { level: 'warn' } });

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
  await fastify.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

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
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`[bunqsy] Server listening on http://0.0.0.0:${port}`);

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
  const shutdown = (): void => {
    console.log('[bunqsy] Shutting down...');
    stopLoop();
    dreamTask.stop();
    try { closeDb(); } catch { /* ignore */ }
    void fastify.close().then(() => { process.exit(0); });
  };

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

boot().catch((err: unknown) => {
  console.error('[bunqsy] Fatal boot error:', err);
  process.exit(1);
});
