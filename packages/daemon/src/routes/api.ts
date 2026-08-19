import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuid } from 'uuid';
import { getDb } from '../memory/db.js';
import { isAllowedOrigin, validateWebhookRequest } from '../bunq/webhook.js';
import { getInterventionHistory, resolveIntervention } from '../memory/interventions.js';
import { confirmPlan, executePlan, cancelPlan, createExecutionPlan } from '../bunq/execute.js';
import { offerPatternPromotion } from '../intervention/pattern-promotion.js';
import { getAccountSummaries } from '../state.js';
import type { BunqClient } from '../bunq/client.js';
import type { ScoreLogRow, OracleVote, InterventionRow, TransactionRow } from '@bunqsy/shared';

// ── Serialisable card summary returned to the frontend ─────────────────────────
interface CardSummary {
  id: number;
  type: string | null;
  cardEndpoint: string;
  status: string | null;
  nameOnCard: string | null;
  lastFourDigits: string | null;
  expiryDate: string | null;
}

// ── Serialisable bunq savings goal returned to the frontend ───────────────────
interface BunqGoalSummary {
  id: number;
  name: string;
  targetAmount: number;
  currentAmount: number;
  currency: string;
  status: string;
  source: 'bunq';
}

export async function registerApiRoutes(
  fastify: FastifyInstance,
  triggerTick?: () => Promise<void>,
  client?: BunqClient,
): Promise<void> {

  // ── GET /api/score — latest BUNQSY score ────────────────────────────────────
  fastify.get('/api/score', async (_req: FastifyRequest, reply: FastifyReply) => {
    const db = getDb();
    const score = db
      .prepare(`SELECT * FROM score_log ORDER BY logged_at DESC LIMIT 1`)
      .get() as ScoreLogRow | undefined;
    return reply.send(score ?? null);
  });

  // ── GET /api/accounts — multi-account summaries (Phase 14) ────────────────
  fastify.get('/api/accounts', async (_req: FastifyRequest, reply: FastifyReply) => {
    const summaries = getAccountSummaries();
    return reply.send(summaries);
  });

  // ── GET /api/interventions — recent intervention history ───────────────────
  fastify.get('/api/interventions', async (_req: FastifyRequest, reply: FastifyReply) => {
    const db = getDb();
    return reply.send(getInterventionHistory(db, 20));
  });

  // ── POST /api/confirm/:planId — confirm + execute, or allow (cancel) a plan ─
  fastify.post(
    '/api/confirm/:planId',
    async (
      req: FastifyRequest<{
        Params: { planId: string };
        Body:   { action?: 'allow' | 'block' };
      }>,
      reply: FastifyReply,
    ) => {
      const { planId } = req.params;
      const action = (req.body as { action?: string } | undefined)?.action ?? 'block';

      try {
        const db = getDb();
        const interventionRow = db
          .prepare(
            `SELECT * FROM interventions
             WHERE execution_plan_id = ? AND status = 'SHOWN'`,
          )
          .get(planId) as InterventionRow | undefined;

        if (action === 'allow') {
          // User confirmed the transaction is legitimate — cancel the block plan
          await cancelPlan(planId);
          if (interventionRow) resolveIntervention(db, interventionRow.id, 'DISMISSED');
        } else {
          // Block action: confirm then execute the CANCEL_DRAFT plan
          // Constitutional rule: confirm first, then execute — never skip confirm step
          await confirmPlan(planId);
          await executePlan(planId);
          if (interventionRow) {
            resolveIntervention(db, interventionRow.id, 'EXECUTED');
            // Async background: ask Claude if this confirmed action is a repeatable pattern
            void offerPatternPromotion(
              db,
              interventionRow.type,
              interventionRow.narration,
              JSON.parse(interventionRow.oracle_votes) as OracleVote[],
            );
          }
        }

        return reply.send({ ok: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ ok: false, error: message });
      }
    },
  );

  // ── POST /api/dismiss/:interventionId — dismiss an active intervention ────
  fastify.post(
    '/api/dismiss/:interventionId',
    async (req: FastifyRequest<{ Params: { interventionId: string } }>, reply: FastifyReply) => {
      const { interventionId } = req.params;
      const db = getDb();
      resolveIntervention(db, interventionId, 'DISMISSED');
      return reply.send({ ok: true });
    },
  );

  // ── GET /api/dna — Financial DNA card + patterns ──────────────────────────
  fastify.get('/api/dna', async (_req: FastifyRequest, reply: FastifyReply) => {
    const db = getDb();

    const session = db
      .prepare(
        `SELECT dna_card, suggestions, completed_at FROM dream_sessions
         WHERE status = 'COMPLETED' ORDER BY completed_at DESC LIMIT 1`,
      )
      .get() as { dna_card: string | null; suggestions: string | null; completed_at: string } | undefined;

    const patterns = db
      .prepare(
        `SELECT name, confidence FROM patterns
         WHERE confidence > 0.4 ORDER BY confidence DESC LIMIT 6`,
      )
      .all() as Array<{ name: string; confidence: number }>;

    if (!session?.dna_card) {
      return reply.send({ dnaCard: null, suggestions: [], patterns, completedAt: null });
    }

    let suggestions: string[] = [];
    try {
      suggestions = JSON.parse(session.suggestions ?? '[]') as string[];
    } catch { /* ignore parse errors */ }

    return reply.send({
      dnaCard:     session.dna_card,
      suggestions,
      patterns,
      completedAt: session.completed_at,
    });
  });

  // ── GET /api/transactions — recent transactions from DB ───────────────────
  fastify.get(
    '/api/transactions',
    async (req: FastifyRequest<{ Querystring: { limit?: string } }>, reply: FastifyReply) => {
      const db = getDb();
      const limit = Math.min(parseInt((req.query as { limit?: string }).limit ?? '30', 10), 100);
      const rows = db
        .prepare(
          `SELECT t.*, j.category AS je_category
           FROM transactions t
           LEFT JOIN journal_entries j ON j.tx_id = t.id
           ORDER BY t.created_at DESC LIMIT ?`,
        )
        .all(limit) as TransactionRow[];
      return reply.send(rows);
    },
  );

  // ── GET /api/insights — weekly spending, goals, and latest dream session ────
  fastify.get('/api/insights', async (_req: FastifyRequest, reply: FastifyReply) => {
    const db = getDb();

    // ── Weekly spending (last 7 days, Mon-first order) ──────────────────────
    type SpendingRow = { dow: string; total: number };
    const spendingRows = db
      .prepare(
        `SELECT strftime('%w', created_at) as dow, SUM(ABS(amount)) as total
         FROM transactions
         WHERE created_at >= datetime('now', '-7 days') AND amount < 0
         GROUP BY dow`,
      )
      .all() as SpendingRow[];

    const DOW_LABELS: Record<string, string> = {
      '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu',
      '5': 'Fri', '6': 'Sat', '0': 'Sun',
    };
    const DOW_ORDER = ['1', '2', '3', '4', '5', '6', '0'];

    const spendingMap = new Map<string, number>(
      spendingRows.map((r) => [r.dow, r.total]),
    );

    const weeklySpending = DOW_ORDER.map((dow) => ({
      day:    DOW_LABELS[dow] as string,
      amount: spendingMap.get(dow) ?? 0,
    }));

    // ── Goals ────────────────────────────────────────────────────────────────
    type GoalRow = { name: string; target_amount: number; current_amount: number };
    const goalRows = db
      .prepare(
        `SELECT name, target_amount, current_amount FROM goals
         WHERE enabled = 1 ORDER BY created_at DESC LIMIT 5`,
      )
      .all() as GoalRow[];

    const goals = goalRows.map((g) => ({
      name:          g.name,
      targetAmount:  g.target_amount,
      currentAmount: g.current_amount,
    }));

    // ── Latest completed dream session ───────────────────────────────────────
    type DreamRow = {
      briefing_text:    string;
      dna_card:         string | null;
      suggestions:      string;
      completed_at:     string | null;
      patterns_updated: number | null;
      patterns_created: number | null;
    };
    const dreamRow = db
      .prepare(
        `SELECT briefing_text, dna_card, suggestions, completed_at,
                patterns_updated, patterns_created
         FROM dream_sessions WHERE status = 'COMPLETED'
         ORDER BY completed_at DESC LIMIT 1`,
      )
      .get() as DreamRow | undefined;

    let dreamSession: {
      briefingText:    string;
      dnaCard:         string | null;
      suggestions:     string[];
      completedAt:     string | null;
      patternsUpdated: number | null;
      patternsCreated: number | null;
    } | null = null;

    if (dreamRow !== undefined) {
      let suggestions: string[] = [];
      try {
        suggestions = JSON.parse(dreamRow.suggestions) as string[];
      } catch { /* ignore malformed JSON */ }

      dreamSession = {
        briefingText:    dreamRow.briefing_text,
        dnaCard:         dreamRow.dna_card ?? null,
        suggestions,
        completedAt:     dreamRow.completed_at ?? null,
        patternsUpdated: dreamRow.patterns_updated ?? null,
        patternsCreated: dreamRow.patterns_created ?? null,
      };
    }

    // ── KPIs (last 30 days vs prior 30 days) ────────────────────────────────
    type KpiRow = { total_income: number | null; total_expenses: number | null };

    const kpiCurrent = db.prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)        as total_income,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END)   as total_expenses
      FROM transactions
      WHERE created_at >= datetime('now', '-30 days')
    `).get() as KpiRow | undefined;

    const kpiPrev = db.prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)        as total_income,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END)   as total_expenses
      FROM transactions
      WHERE created_at >= datetime('now', '-60 days')
        AND created_at <  datetime('now', '-30 days')
    `).get() as KpiRow | undefined;

    const income30   = kpiCurrent?.total_income    ?? 0;
    const expenses30 = kpiCurrent?.total_expenses  ?? 0;
    const incPrev    = kpiPrev?.total_income        ?? 0;
    const expPrev    = kpiPrev?.total_expenses      ?? 0;

    const savingRate      = income30 > 0 ? Math.round(((income30 - expenses30) / income30) * 100) : 0;
    const prevSavingRate  = incPrev  > 0 ? Math.round(((incPrev  - expPrev)   / incPrev)  * 100) : 0;
    const burnRateDaily   = Math.round((expenses30 / 30) * 100) / 100;

    return reply.send({
      weeklySpending,
      goals,
      dreamSession,
      kpis: {
        savingRate,
        savingRateDelta:  savingRate - prevSavingRate,
        burnRateDaily,
        totalIncome30d:   Math.round(income30   * 100) / 100,
        totalExpenses30d: Math.round(expenses30 * 100) / 100,
      },
    });
  });

  // ── GET /api/cards — live card list from bunq ─────────────────────────────
  fastify.get('/api/cards', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!client) return reply.status(503).send({ error: 'bunq client not available' });
    try {
      const cards = await client.getCards();
      const summaries: CardSummary[] = cards.map((c) => {
        const raw = c as Record<string, unknown>;
        const typeLower = (c.type ?? '').toLowerCase();
        return {
          id:             c.id,
          type:           c.type ?? null,
          cardEndpoint:   typeLower.includes('credit') ? 'card-credit' : 'card-debit',
          status:         c.status ?? null,
          nameOnCard:     (raw['name_on_card'] as string | null) ?? null,
          lastFourDigits: (raw['primary_account_number_four_digit'] as string | null) ?? null,
          expiryDate:     (raw['expiry_date'] as string | null) ?? null,
        };
      });

      // Sandbox: bunq doesn't auto-provision cards — inject demo cards so the
      // freeze/unfreeze PLAN→CONFIRM→EXECUTE flow can be demonstrated
      if (summaries.length === 0 && process.env['BUNQ_ENV'] !== 'production') {
        const accounts = await client.getAccounts();
        const primary  = accounts.find(a => a.status === 'ACTIVE');
        const aliasArr = (primary as unknown as { alias?: Array<{ type?: string; name?: string }> })?.alias;
        const ibanAlias = aliasArr?.find((a: { type?: string; name?: string }) => a.type === 'IBAN');
        const holderName = ibanAlias?.name ?? 'BUNQSY USER';
        const last4 = (primary?.id ?? 0).toString().slice(-4).padStart(4, '0');

        summaries.push(
          {
            id:             99001,
            type:           'MASTERCARD',
            cardEndpoint:   'card-debit',
            status:         'ACTIVE',
            nameOnCard:     holderName.toUpperCase(),
            lastFourDigits: last4,
            expiryDate:     '12/28',
          },
          {
            id:             99002,
            type:           'VIRTUAL_MASTERCARD',
            cardEndpoint:   'card-debit',
            status:         'ACTIVE',
            nameOnCard:     holderName.toUpperCase(),
            lastFourDigits: '0042',
            expiryDate:     '09/27',
          },
        );
      }

      return reply.send(summaries);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(503).send({ error: 'Unable to fetch cards from bunq', detail: message });
    }
  });

  // ── POST /api/cards/:cardId/freeze — create a CARD_FREEZE ExecutionPlan ───
  fastify.post(
    '/api/cards/:cardId/freeze',
    async (
      req: FastifyRequest<{
        Params: { cardId: string };
        Body:   { cardEndpoint?: string; nameOnCard?: string; lastFourDigits?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { cardId } = req.params;
      const body = req.body as { cardEndpoint?: string; nameOnCard?: string; lastFourDigits?: string } | undefined;
      const cardEndpoint   = body?.cardEndpoint   ?? 'card-debit';
      const nameOnCard     = body?.nameOnCard     ?? 'card';
      const lastFourDigits = body?.lastFourDigits ?? '****';

      const plan = await createExecutionPlan(
        [{
          id:          uuid(),
          type:        'CARD_FREEZE',
          description: `Freeze ${nameOnCard} (…${lastFourDigits})`,
          payload:     { cardId: parseInt(cardId, 10), cardEndpoint },
        }],
        `Freezing your ${nameOnCard} card ending in ${lastFourDigits}. All new transactions will be blocked until you unfreeze it. This action can be reversed at any time.`,
      );
      return reply.send({ planId: plan.id, narratedText: plan.narratedText });
    },
  );

  // ── POST /api/cards/:cardId/unfreeze — create a CARD_UNFREEZE ExecutionPlan
  fastify.post(
    '/api/cards/:cardId/unfreeze',
    async (
      req: FastifyRequest<{
        Params: { cardId: string };
        Body:   { cardEndpoint?: string; nameOnCard?: string; lastFourDigits?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { cardId } = req.params;
      const body = req.body as { cardEndpoint?: string; nameOnCard?: string; lastFourDigits?: string } | undefined;
      const cardEndpoint   = body?.cardEndpoint   ?? 'card-debit';
      const nameOnCard     = body?.nameOnCard     ?? 'card';
      const lastFourDigits = body?.lastFourDigits ?? '****';

      const plan = await createExecutionPlan(
        [{
          id:          uuid(),
          type:        'CARD_UNFREEZE',
          description: `Unfreeze ${nameOnCard} (…${lastFourDigits})`,
          payload:     { cardId: parseInt(cardId, 10), cardEndpoint },
        }],
        `Reactivating your ${nameOnCard} card ending in ${lastFourDigits}. The card will accept transactions again immediately after confirmation.`,
      );
      return reply.send({ planId: plan.id, narratedText: plan.narratedText });
    },
  );

  // ── GET /api/bunq-goals — savings goals from bunq per savings account ──────
  fastify.get('/api/bunq-goals', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!client) return reply.send([]);
    try {
      const accounts = await client.getAccounts();
      const savingsAccounts = accounts.filter(
        (a) => a.status === 'ACTIVE' &&
          (a._wrapperType === 'MonetaryAccountSavings' || a._wrapperType === 'MonetaryAccountBank'),
      );

      const allGoals: BunqGoalSummary[] = [];
      for (const account of savingsAccounts) {
        const goals = await client.getSavingsGoals(account.id);
        for (const g of goals) {
          if ((g.status ?? 'ACTIVE') !== 'ACTIVE') continue;
          const raw = g as Record<string, unknown>;
          const goalAmt = parseFloat(((raw['goal_amount'] as { value?: string } | undefined)?.value) ?? '0');
          const savedAmt = parseFloat(((raw['saved_amount'] as { value?: string } | undefined)?.value) ?? '0');
          const currency = ((raw['goal_amount'] as { currency?: string } | undefined)?.currency) ?? 'EUR';
          allGoals.push({
            id:            g.id,
            name:          g.name ?? `Goal ${g.id}`,
            targetAmount:  goalAmt,
            currentAmount: savedAmt,
            currency,
            status:        g.status ?? 'ACTIVE',
            source:        'bunq',
          });
        }
      }
      return reply.send(allGoals);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[api] /api/bunq-goals failed (non-fatal):', message);
      return reply.send([]);
    }
  });

  // ── GET /api/health — liveness probe for SRE / platform ────────────────────
  fastify.get('/api/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    const db = getDb();
    let dbOk = false;
    try { db.prepare('SELECT 1').get(); dbOk = true; } catch { dbOk = false; }
    const lastScore = db.prepare('SELECT logged_at FROM score_log ORDER BY logged_at DESC LIMIT 1').get() as { logged_at?: string } | undefined;
    const lastTick = db.prepare('SELECT tick_at FROM tick_log ORDER BY tick_at DESC LIMIT 1').get() as { tick_at?: string } | undefined;
    const bunqMode = process.env.BUNQ_OFFLINE_MODE === 'true' ? 'offline' : 'live';
    return reply.send({
      status: dbOk ? 'ok' : 'degraded',
      uptime: process.uptime(),
      db: dbOk ? 'ok' : 'error',
      bunq: bunqMode,
      lastScore: lastScore?.logged_at ?? null,
      lastTick:  lastTick?.tick_at ?? null,
      env: process.env.BUNQ_ENV ?? 'sandbox',
    });
  });

  // ── POST /api/webhook — bunq event webhook ─────────────────────────────────
  fastify.post('/api/webhook', async (req: FastifyRequest, reply: FastifyReply) => {
    const remoteIp =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      ?? req.socket.remoteAddress
      ?? '';

    if (!isAllowedOrigin(remoteIp)) {
      return reply.status(403).send({ error: 'Forbidden — IP not in bunq CIDR range' });
    }

    // Webhook signature verification — PSD2 compliance (always enforced in production,
    // warn-only in sandbox where header may be absent on simulated calls)
    try {
      const sessionRow = getDb().prepare('SELECT server_public_key FROM sessions ORDER BY created_at DESC LIMIT 1').get() as { server_public_key: string } | undefined;
      if (sessionRow?.server_public_key) {
        const rawBody = JSON.stringify(req.body ?? {});
        const headers = req.headers as Record<string, string>;
        const hasSig = Boolean(headers['x-bunq-client-signature'] || headers['x-bunq-client-signature'.toLowerCase()]);
        if (hasSig) {
          const session = { serverPublicKey: sessionRow.server_public_key } as import('../bunq/auth.js').BunqSession;
          const valid = validateWebhookRequest(rawBody, headers, session);
          if (!valid) {
            if (process.env.BUNQ_ENV === 'production') {
              return reply.status(401).send({ error: 'Invalid webhook signature' });
            }
            console.warn('[webhook] Signature invalid in sandbox — allowing (set BUNQ_ENV=production to enforce)');
          }
        } else if (process.env.BUNQ_ENV === 'production') {
          return reply.status(401).send({ error: 'Missing webhook signature' });
        }
      }
    } catch (e) {
      console.warn('[webhook] Signature check error (non-fatal):', (e as Error).message);
    }

    // Parse the bunq notification payload
    // Shape: { NotificationUrl: { category, event_type, object } }
    const body = req.body as { NotificationUrl?: { category?: string; event_type?: string } } | undefined;
    const category  = body?.NotificationUrl?.category ?? 'UNKNOWN';
    const eventType = body?.NotificationUrl?.event_type ?? 'UNKNOWN';

    console.log(`[webhook] Received: category=${category} event=${eventType}`);

    // Trigger an immediate heartbeat tick for payment-relevant events
    const TICK_CATEGORIES = new Set(['PAYMENT', 'MUTATION', 'REQUEST', 'SCHEDULE_RESULT']);
    if (TICK_CATEGORIES.has(category) && triggerTick) {
      // Slight delay so bunq has committed the transaction before we fetch
      setTimeout(() => {
        void triggerTick().catch((err: Error) =>
          console.error('[webhook] Triggered tick failed:', err.message),
        );
      }, 800);
    }

    return reply.status(200).send({ ok: true });
  });
}
