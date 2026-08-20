/**
 * ⚠️  WRITE GATEWAY — CONSTITUTIONAL BOUNDARY  ⚠️
 * This is the ONLY file in the entire codebase permitted to make
 * POST, PUT, or DELETE requests to the bunq API.
 * All write operations must flow through executePlan().
 * Direct fetch/axios write calls anywhere else are a constitutional violation.
 * See CLAUDE.md Rule 2.
 */

import { v4 as uuid } from 'uuid';
import { signRequestBody } from './signing.js';
import { getDb } from '../memory/db.js';
import { validateSteps, validateStep, pathSegment } from './step-validation.js';
import type {
  ExecutionStep,
  ExecutionPlan,
  ExecutionStepType,
  ExecutionPlanStatus,
} from '@bunqsy/shared';

export type { ExecutionStep, ExecutionPlan, ExecutionStepType, ExecutionPlanStatus };

function getBunqBaseUrl(): string {
  const env = process.env.BUNQ_ENV;
  if (env === 'production') {
    const url = process.env.BUNQ_PRODUCTION_URL;
    if (!url) throw new Error('BUNQ_PRODUCTION_URL is not set');
    return url;
  }
  const url = process.env.BUNQ_SANDBOX_URL;
  if (!url) throw new Error('BUNQ_SANDBOX_URL is not set');
  return url;
}

export async function createExecutionPlan(
  steps: ExecutionStep[],
  narratedText: string,
): Promise<ExecutionPlan> {
  // Gate 1 of 2: reject unsafe payloads before they are persisted, so a bad
  // plan can never be confirmed later by a caller who did not create it.
  const safeSteps = validateSteps(steps);

  const plan: ExecutionPlan = {
    id: uuid(),
    createdAt: new Date(),
    narratedText: narratedText.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 2000),
    steps: safeSteps,
    status: 'PENDING',
  };

  const db = getDb();
  db.prepare(
    `INSERT INTO execution_plans (id, narrated_text, steps, status, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(plan.id, plan.narratedText, JSON.stringify(plan.steps), plan.status);

  return plan;
}

export async function confirmPlan(planId: string): Promise<void> {
  const db = getDb();
  const row = db
    .prepare(`SELECT status FROM execution_plans WHERE id = ?`)
    .get(planId) as { status: string } | undefined;

  if (!row) throw new Error(`Plan ${planId} not found`);
  if (row.status !== 'PENDING') {
    throw new Error(`Plan ${planId} must be PENDING to confirm (current: ${row.status})`);
  }

  db.prepare(
    `UPDATE execution_plans SET status = 'CONFIRMED', confirmed_at = datetime('now') WHERE id = ?`,
  ).run(planId);
}

export async function executePlan(planId: string): Promise<void> {
  const db = getDb();

  const row = db
    .prepare(`SELECT * FROM execution_plans WHERE id = ?`)
    .get(planId) as {
    id: string;
    narrated_text: string;
    steps: string;
    status: string;
  } | undefined;

  if (!row) throw new Error(`Plan ${planId} not found`);
  if (row.status !== 'CONFIRMED') {
    throw new Error(`Plan ${planId} must be CONFIRMED before execution (current: ${row.status})`);
  }

  // Gate 2 of 2: re-validate at execution time. The row may predate the current
  // validation rules, or have been written by another process sharing the DB.
  const steps = validateSteps(JSON.parse(row.steps) as ExecutionStep[]);

  // SRE offline fallback — short-circuit bunq writes when sandbox is down.
  // Plans still go through CONFIRMED → EXECUTED lifecycle so the UI demo works.
  if (process.env.BUNQ_OFFLINE_MODE === 'true') {
    console.warn(`[bunq] OFFLINE_MODE — simulating ${steps.length} step(s) for plan ${planId}`);
    for (const step of steps) {
      db.prepare(
        `INSERT INTO execution_step_results
           (id, plan_id, step_id, success, bunq_response, error_message, executed_at)
         VALUES (?, ?, ?, 1, ?, NULL, datetime('now'))`,
      ).run(uuid(), planId, step.id, JSON.stringify({ offline: true, simulated: true, stepType: step.type }));
    }
    db.prepare(
      `UPDATE execution_plans SET status = 'EXECUTED', executed_at = datetime('now') WHERE id = ?`,
    ).run(planId);
    return;
  }

  // Load latest session for signing credentials
  const sessionRow = db
    .prepare(
      `SELECT session_token, private_key_pem, user_id
       FROM sessions ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as {
    session_token: string;
    private_key_pem: string;
    user_id: number;
  } | undefined;

  if (!sessionRow) throw new Error('No active session found in DB');

  const baseUrl = getBunqBaseUrl();

  for (const step of steps) {
    let success = false;
    let bunqResponse: string | null = null;
    let errorMessage: string | null = null;

    try {
      const { method, path, body } = buildStepRequest(step, sessionRow.user_id);
      const bodyStr = JSON.stringify(body);
      const signature = signRequestBody(bodyStr, sessionRow.private_key_pem);

      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'BunqsyFinance/1.0',
          'X-Bunq-Client-Authentication': sessionRow.session_token,
          'X-Bunq-Client-Signature': signature,
        },
        body: bodyStr,
      });

      const text = await res.text();
      if (!res.ok) {
        errorMessage = `HTTP ${res.status}: ${text}`;
      } else {
        success = true;
        bunqResponse = text;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    // Append-only step result log
    db.prepare(
      `INSERT INTO execution_step_results
         (id, plan_id, step_id, success, bunq_response, error_message, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(uuid(), planId, step.id, success ? 1 : 0, bunqResponse, errorMessage);

    if (!success) {
      throw new Error(`Step ${step.id} (${step.type}) failed: ${errorMessage}`);
    }
  }

  db.prepare(
    `UPDATE execution_plans SET status = 'EXECUTED', executed_at = datetime('now') WHERE id = ?`,
  ).run(planId);
}

/**
 * Registers bunq notification filters (webhooks) for PAYMENT and MUTATION events.
 * Only runs when WEBHOOK_PUBLIC_URL is set. Safe to call on every boot — bunq
 * overwrites existing filters for the same account.
 */
export async function registerNotificationFilter(
  userId: number,
  accountId: number,
  callbackUrl: string,
): Promise<void> {
  const db = getDb();
  const sessionRow = db
    .prepare(`SELECT session_token, private_key_pem FROM sessions ORDER BY created_at DESC LIMIT 1`)
    .get() as { session_token: string; private_key_pem: string } | undefined;

  if (!sessionRow) throw new Error('No active session for webhook registration');

  const baseUrl = getBunqBaseUrl();
  const path    = `/user/${pathSegment(userId)}/monetary-account/${pathSegment(accountId)}/notification-filter-url`;
  const body    = JSON.stringify({
    notification_filters: [
      { category: 'PAYMENT',  notification_target: callbackUrl },
      { category: 'MUTATION', notification_target: callbackUrl },
    ],
  });
  const signature = signRequestBody(body, sessionRow.private_key_pem);

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'BunqsyFinance/1.0',
      'X-Bunq-Client-Authentication': sessionRow.session_token,
      'X-Bunq-Client-Signature': signature,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notification filter registration failed: ${res.status} ${text}`);
  }

  console.log(`[bunqsy] Webhook registered → ${callbackUrl} (PAYMENT + MUTATION)`);
}

export async function cancelPlan(planId: string): Promise<void> {
  const db = getDb();
  const row = db
    .prepare(`SELECT status FROM execution_plans WHERE id = ?`)
    .get(planId) as { status: string } | undefined;

  if (!row) throw new Error(`Plan ${planId} not found`);
  if (row.status === 'EXECUTED') {
    throw new Error(`Plan ${planId} has already been executed and cannot be cancelled`);
  }

  db.prepare(
    `UPDATE execution_plans SET status = 'CANCELLED' WHERE id = ?`,
  ).run(planId);
}

// ─── Step → bunq request mapper ──────────────────────────────────────────────

interface BunqRequest {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body: unknown;
}

function buildStepRequest(step: ExecutionStep, userId: number): BunqRequest {
  // Never trust the caller's payload shape here either — validateStep() coerces
  // ids to integers and constrains cardEndpoint to a known set, which is what
  // stops "cardEndpoint=../../monetary-account/1/payment" reaching bunq signed.
  const payload = validateStep(step).payload as Record<string, unknown>;
  const uid = pathSegment(userId);

  switch (step.type) {
    case 'PAYMENT':
      return {
        method: 'POST',
        path: `/user/${uid}/monetary-account/${pathSegment(payload['fromAccountId'] as number)}/payment`,
        body: {
          amount: { value: String(payload['amount']), currency: payload['currency'] ?? 'EUR' },
          counterparty_alias: {
            type: 'IBAN',
            value: payload['toIban'],
            name: payload['toName'],
          },
          description: payload['description'] ?? '',
        },
      };

    case 'SAVINGS_TRANSFER':
      return {
        method: 'POST',
        path: `/user/${uid}/monetary-account/${pathSegment(payload['fromAccountId'] as number)}/payment`,
        body: {
          amount: { value: String(payload['amount']), currency: payload['currency'] ?? 'EUR' },
          counterparty_alias: {
            type: 'ID',
            value: String(payload['toAccountId']),
          },
          description: payload['description'] ?? 'BUNQSY auto-save',
        },
      };

    case 'DRAFT_PAYMENT':
      return {
        method: 'POST',
        path: `/user/${uid}/draft-payment`,
        body: {
          number_of_required_accepts: 1,
          entries: [payload['entry']],
        },
      };

    case 'CANCEL_DRAFT':
      return {
        method: 'DELETE',
        path: `/user/${uid}/draft-payment/${pathSegment(payload['draftPaymentId'] as number)}`,
        body: {},
      };

    case 'SANDBOX_FUND':
      return {
        method: 'POST',
        path: `/user/${uid}/monetary-account/${pathSegment(payload['accountId'] as number)}/request-inquiry`,
        body: {
          amount_inquired: {
            value:    String(payload['amount'] ?? '500'),
            currency: 'EUR',
          },
          counterparty_alias: {
            type:  'EMAIL',
            value: 'sugardaddy@bunq.com',
            name:  'Sugar Daddy',
          },
          description:  payload['description'] ?? "Fund sandbox account",
          allow_bunqme: false,
        },
      };

    case 'CARD_FREEZE':
      return {
        method: 'PUT',
        path: `/user/${uid}/${pathSegment((payload['cardEndpoint'] as string) ?? 'card-debit')}/${pathSegment(payload['cardId'] as number)}`,
        body: { status: 'DEACTIVATED' },
      };

    case 'CARD_UNFREEZE':
      return {
        method: 'PUT',
        path: `/user/${uid}/${pathSegment((payload['cardEndpoint'] as string) ?? 'card-debit')}/${pathSegment(payload['cardId'] as number)}`,
        body: { status: 'ACTIVE' },
      };

    case 'CREATE_SAVINGS_GOAL':
      return {
        method: 'POST',
        path: `/user/${uid}/monetary-account/${pathSegment(payload['accountId'] as number)}/savings-goal`,
        body: {
          name:        payload['name'],
          goal_amount: { value: String(payload['amount']), currency: payload['currency'] ?? 'EUR' },
        },
      };

    default: {
      const exhaustive: never = step.type;
      throw new Error(`Unknown step type: ${exhaustive}`);
    }
  }
}
