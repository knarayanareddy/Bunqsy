import type Database from 'better-sqlite3';
import { type BunqClient } from './client.js';
import { type TaggedMonetaryAccount, type AccountSummary, type AccountClassification } from '@bunqsy/shared';
import { getGoals } from '../memory/profile.js';
import { parseEur } from '../lib/parseEur.js';

/**
 * Returns all monetary accounts (bank, savings, joint) for the authenticated user.
 * Each account is tagged with _wrapperType for downstream discrimination.
 */
export async function getAllAccounts(client: BunqClient): Promise<TaggedMonetaryAccount[]> {
  return client.getAccounts();
}

/**
 * Returns the primary (current/checking) account.
 *
 * Selection strategy:
 *   1. Active MonetaryAccountBank accounts (true current/checking accounts)
 *   2. If none found, first active account of any type
 * bunq always returns the main account first in the response list, so
 * taking the first match is reliable.
 */
export async function getPrimaryAccount(client: BunqClient): Promise<TaggedMonetaryAccount> {
  const accounts = await client.getAccounts();

  // Prefer active MonetaryAccountBank (current/checking)
  const bankAccounts = accounts.filter(
    (a) => a._wrapperType === 'MonetaryAccountBank' && a.status === 'ACTIVE',
  );
  if (bankAccounts.length > 0) {
    const primary = bankAccounts[0];
    if (!primary) throw new Error('No primary account found after filter');
    return primary;
  }

  // Fallback: first active account of any type
  const anyActive = accounts.find((a) => a.status === 'ACTIVE');
  if (!anyActive) {
    throw new Error('No active monetary account found for this user');
  }
  return anyActive;
}

/**
 * Returns all savings (jar) accounts.
 * Includes both MonetaryAccountSavings and MonetaryAccountJoint sub-accounts.
 */
export async function getSavingsAccounts(client: BunqClient): Promise<TaggedMonetaryAccount[]> {
  const accounts = await client.getAccounts();
  return accounts.filter(
    (a) =>
      (a._wrapperType === 'MonetaryAccountSavings' || a._wrapperType === 'MonetaryAccountJoint') &&
      a.status === 'ACTIVE',
  );
}

/**
 * Returns the sum of balances across all active accounts in EUR.
 * Amounts are stored as strings by bunq ("1234.56") and parsed here.
 */
export async function getTotalBalance(client: BunqClient): Promise<number> {
  const accounts = await client.getAccounts();
  return accounts
    .filter((a) => a.status === 'ACTIVE')
    .reduce((sum, account) => sum + parseEur(account.balance?.value), 0);
}

/**
 * Returns the numeric balance of a single account.
 * Returns 0 if the account has no balance field.
 */
export function parseAccountBalance(account: TaggedMonetaryAccount): number {
  return parseEur(account.balance?.value);
}

// ─── Phase 14: Multi-account intelligence ────────────────────────────────────

/**
 * Classifies a single account.
 * Primary = first active MonetaryAccountBank (determined by caller via isPrimary flag).
 */
export function classifyAccount(
  account: TaggedMonetaryAccount,
  isPrimary: boolean,
): AccountClassification {
  if (isPrimary) return 'primary';
  if (account._wrapperType === 'MonetaryAccountJoint') return 'joint';
  if (account._wrapperType === 'MonetaryAccountSavings') return 'savings';
  return 'other';
}

/**
 * Builds a classified, enriched summary for every active account.
 *
 * Accepts a pre-fetched accounts array so the caller (recall) can reuse the
 * list it already retrieved — no second network call.
 *
 * For each account:
 *   - Classification: primary | savings | joint | other
 *   - Recent transaction count (7-day window, from local DB)
 *   - Joint-account unusual spend flag (>€200 outflow in 24 h)
 *   - Savings goal link and progress (0–1) if a goal is linked via jar_account_id
 */
export function buildAccountSummaries(
  accounts: TaggedMonetaryAccount[],
  db: Database.Database,
): AccountSummary[] {
  const active = accounts.filter((a) => a.status === 'ACTIVE');
  const goals  = getGoals(db);

  let primaryAssigned = false;

  return active.map((account): AccountSummary => {
    // Classify: first active Bank account becomes 'primary'
    const isPrimary =
      !primaryAssigned && account._wrapperType === 'MonetaryAccountBank';
    if (isPrimary) primaryAssigned = true;

    const classification = classifyAccount(account, isPrimary);
    const balanceCents   = Math.round(parseEur(account.balance?.value) * 100);

    // Recent transaction count from the local cache
    const recentRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE bunq_account_id = ?
           AND created_at >= datetime('now', '-7 days')`,
      )
      .get(account.id) as { n: number };

    // Joint-account unusual spend: >€200 outflow in last 24 h is a flag
    let unusualSpendFlag = false;
    if (classification === 'joint') {
      const spendRow = db
        .prepare(
          `SELECT COALESCE(SUM(ABS(amount)), 0) AS total
           FROM transactions
           WHERE bunq_account_id = ?
             AND amount < -200
             AND created_at >= datetime('now', '-24 hours')`,
        )
        .get(account.id) as { total: number };
      unusualSpendFlag = spendRow.total > 200;
    }

    // Savings goal link
    const linkedGoal    = goals.find((g) => g.jar_account_id === account.id && g.enabled === 1);
    const goalLinked    = linkedGoal !== undefined;
    const goalProgress  = linkedGoal
      ? Math.min(1, linkedGoal.current_amount / Math.max(linkedGoal.target_amount, 0.01))
      : null;

    return {
      account,
      classification,
      balanceCents,
      label:            account.description ?? `Account ${account.id}`,
      currency:         account.balance?.currency ?? 'EUR',
      recentTxCount:    recentRow.n,
      unusualSpendFlag,
      goalLinked,
      goalProgress,
    };
  });
}
