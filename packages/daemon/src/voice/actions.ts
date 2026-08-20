import { isDemoAllowed } from '../security/demo-guard.js';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import type { WSMessage, ScoreLogRow } from '@bunqsy/shared';
import { triggerDream } from '../dream/trigger.js';
import { createExecutionPlan, confirmPlan, executePlan } from '../bunq/execute.js';

export interface ActionResult {
  spokenResponse: string;
}

interface DreamSessionRow {
  briefing_text: string | null;
  dna_card:      string | null;
  suggestions:   string | null;
  completed_at:  string | null;
}

interface InterventionSummaryRow {
  type:      string;
  narration: string;
}

interface ForecastPoint {
  date:    string;
  balance: number;
}

// ─── Dream Mode ───────────────────────────────────────────────────────────────

export async function handleTriggerDream(
  db: Database.Database,
  wsEmit: (msg: WSMessage) => void,
): Promise<ActionResult> {
  const running = db
    .prepare(`SELECT id FROM dream_sessions WHERE status = 'RUNNING'`)
    .get();
  if (running) {
    return {
      spokenResponse:
        'Dream mode is already running. I will read out the report when the analysis completes.',
    };
  }

  void triggerDream(db, wsEmit, 'manual');
  return {
    spokenResponse:
      'Dream mode activated. I am now analysing your spending patterns and financial behaviours from the past 30 days. ' +
      'This takes a couple of minutes. Say "read dream report" when you are ready to hear the briefing.',
  };
}

// ─── Sandbox funding ──────────────────────────────────────────────────────────

export async function handleFundSandbox(
  db: Database.Database,
  accountId: number,
  triggerTick: (() => Promise<void>) | undefined,
): Promise<ActionResult> {
  if (!isDemoAllowed()) {
    return { spokenResponse: 'Sandbox funding is only available in the sandbox environment.' };
  }

  const sessionRow = db
    .prepare(`SELECT user_id FROM sessions ORDER BY created_at DESC LIMIT 1`)
    .get() as { user_id: number } | undefined;

  if (!sessionRow) {
    return { spokenResponse: 'No active session found. Please restart the daemon.' };
  }

  try {
    const plan = await createExecutionPlan(
      [{
        id:          uuid(),
        type:        'SANDBOX_FUND',
        description: 'Request €500 from bunq Sugar Daddy sandbox alias',
        payload:     { accountId, amount: '500' },
      }],
      'Requesting €500 from the bunq sandbox Sugar Daddy.',
    );
    await confirmPlan(plan.id);
    await executePlan(plan.id);

    if (triggerTick) setTimeout(() => { void triggerTick().catch(() => {}); }, 1500);

    return {
      spokenResponse:
        'Done. Five hundred euros has been requested from the bunq sandbox Sugar Daddy. ' +
        'Your balance will update in a moment.',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { spokenResponse: `Sandbox funding failed: ${message}` };
  }
}

// ─── Demo simulations ─────────────────────────────────────────────────────────

export function handleSimulateFraud(
  db: Database.Database,
  activeAID: number,
  triggerTick: (() => Promise<void>) | undefined,
): ActionResult {
  if (!isDemoAllowed()) {
    return { spokenResponse: 'Fraud simulation is only available in the sandbox environment.' };
  }

  const txTime = new Date();
  txTime.setHours(2, 14, 0, 0);

  db.prepare(
    `INSERT INTO transactions
       (id, bunq_account_id, amount, currency, counterparty_name, description, category, created_at, synced_at)
     VALUES (?, ?, -500.00, 'USD', 'Unknown LLC', 'CARD PURCHASE Ref: 882991X', 'shopping', ?, datetime('now'))`,
  ).run(uuid(), activeAID, txTime.toISOString().slice(0, 19).replace('T', ' '));

  if (triggerTick) setTimeout(() => { void triggerTick().catch(() => {}); }, 100);

  return {
    spokenResponse:
      'Fraud simulation injected: five hundred US dollars to Unknown LLC at 2:14 AM. ' +
      'The risk oracle is now analysing this transaction. ' +
      'If it triggers a fraud alert I will read it out — you can then say "deny" to block it or "authorize" to allow it.',
  };
}

export function handleSimulateSalary(
  db: Database.Database,
  activeAID: number,
  triggerTick: (() => Promise<void>) | undefined,
): ActionResult {
  if (!isDemoAllowed()) {
    return { spokenResponse: 'Salary simulation is only available in the sandbox environment.' };
  }

  db.prepare(
    `INSERT INTO transactions
       (id, bunq_account_id, amount, currency, counterparty_name, description, category, created_at, synced_at)
     VALUES (?, ?, 3500.00, 'EUR', 'Werkgever Nederland BV', 'SALARISBETALING simulation', 'income', datetime('now'), datetime('now'))`,
  ).run(uuid(), activeAID);

  if (triggerTick) setTimeout(() => { void triggerTick().catch(() => {}); }, 100);

  return {
    spokenResponse:
      'Salary simulation complete. Three thousand five hundred euros from Werkgever Nederland BV has been credited. ' +
      'Running financial analysis now — your BUNQSY score and savings recommendations will update shortly.',
  };
}

// ─── Read queries ─────────────────────────────────────────────────────────────

export function handleReadScore(db: Database.Database): ActionResult {
  const row = db
    .prepare(`SELECT * FROM score_log ORDER BY logged_at DESC LIMIT 1`)
    .get() as ScoreLogRow | undefined;

  if (!row) {
    return {
      spokenResponse:
        'No score data yet. The daemon needs to complete at least one heartbeat tick. Try again in a moment.',
    };
  }

  const label = row.score >= 75 ? 'healthy' : row.score >= 50 ? 'moderate' : 'at risk';
  return {
    spokenResponse:
      `Your BUNQSY financial health score is ${Math.round(row.score)} out of 100 — ${label}. ` +
      `Balance health: ${Math.round(row.balance_component ?? 0)}. ` +
      `Spending velocity: ${Math.round(row.velocity_component ?? 0)}. ` +
      `Goals progress: ${Math.round(row.goals_component ?? 0)}. ` +
      `Upcoming obligations: ${Math.round(row.upcoming_component ?? 0)}.`,
  };
}

export function handleReadInterventions(db: Database.Database): ActionResult {
  const rows = db
    .prepare(
      `SELECT type, narration FROM interventions
       WHERE status = 'SHOWN' ORDER BY created_at DESC LIMIT 3`,
    )
    .all() as InterventionSummaryRow[];

  if (rows.length === 0) {
    return { spokenResponse: 'No active alerts at the moment. Your finances look clear.' };
  }

  const summary = rows
    .map((r, i) => `Alert ${i + 1}: ${r.type.replace(/_/g, ' ').toLowerCase()}. ${r.narration}`)
    .join(' ');

  return {
    spokenResponse: `You have ${rows.length} active alert${rows.length > 1 ? 's' : ''}. ${summary}`,
  };
}

export function handleReadForecast(db: Database.Database): ActionResult {
  const row = db
    .prepare(`SELECT data FROM forecast_cache WHERE id = 1`)
    .get() as { data: string } | undefined;

  if (!row) {
    return {
      spokenResponse:
        'No forecast data available yet. The forecast is generated after the first heartbeat tick.',
    };
  }

  try {
    const points = JSON.parse(row.data) as ForecastPoint[];
    if (points.length === 0) return { spokenResponse: 'Forecast data is empty.' };

    const today   = points[0];
    const day7    = points[Math.min(6, points.length - 1)];
    const day30   = points[points.length - 1];
    const lowest  = points.reduce((m, p) => p.balance < m.balance ? p : m, points[0]);
    const warning = lowest.balance < 0
      ? ` Warning: your balance could go negative around ${lowest.date}.`
      : ' No overdraft risk detected in the next 30 days.';

    return {
      spokenResponse:
        `Your 30-day forecast: ` +
        `Today around ${Math.round(today.balance).toLocaleString()} euros. ` +
        `In 7 days: ${Math.round(day7.balance).toLocaleString()} euros. ` +
        `In 30 days: ${Math.round(day30.balance).toLocaleString()} euros.` +
        warning,
    };
  } catch {
    return { spokenResponse: 'Forecast data could not be read. Try refreshing.' };
  }
}

export function handleReadDreamReport(db: Database.Database): ActionResult {
  const row = db
    .prepare(
      `SELECT * FROM dream_sessions WHERE status = 'COMPLETED'
       ORDER BY completed_at DESC LIMIT 1`,
    )
    .get() as DreamSessionRow | undefined;

  if (!row) {
    return {
      spokenResponse:
        'No completed dream report yet. Say "trigger dream mode" to start the overnight analysis.',
    };
  }

  const briefing     = row.briefing_text ?? 'No briefing text available.';
  const dna          = row.dna_card ? ` Your financial DNA: ${row.dna_card}.` : '';
  let   suggestions  = '';

  if (row.suggestions) {
    try {
      const list = JSON.parse(row.suggestions) as string[];
      if (list.length > 0) {
        suggestions = ` My top recommendations: ${list.slice(0, 3).join('. ')}.`;
      }
    } catch { /* ignore */ }
  }

  return { spokenResponse: `${briefing}${dna}${suggestions}`.trim() };
}
