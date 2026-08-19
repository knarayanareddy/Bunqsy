import { z } from 'zod';
import { signRequestBody } from './signing.js';
import { refreshSessionIfNeeded, type BunqSession } from './auth.js';
import {
  MonetaryAccountBankSchema,
  MonetaryAccountListResponseSchema,
  PaymentSchema,
  PaymentListResponseSchema,
  CardSchema,
  CardListResponseSchema,
  ScheduledPaymentSchema,
  ScheduledPaymentListResponseSchema,
  SavingsGoalSchema,
  SavingsGoalListResponseSchema,
  type MonetaryAccountWrapperType,
  type TaggedMonetaryAccount,
  type Payment,
  type Card,
  type ScheduledPayment,
  type SavingsGoal,
} from '@bunqsy/shared';

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

function extractAccountFromItem(item: unknown): TaggedMonetaryAccount {
  const wrapperKeys: MonetaryAccountWrapperType[] = [
    'MonetaryAccountBank',
    'MonetaryAccountSavings',
    'MonetaryAccountJoint',
  ];
  for (const key of wrapperKeys) {
    if (item !== null && typeof item === 'object' && key in item) {
      const account = MonetaryAccountBankSchema.parse((item as Record<string, unknown>)[key]);
      return { ...account, _wrapperType: key };
    }
  }
  throw new Error('Unknown monetary account type in response');
}

function extractCardFromItem(item: unknown): Card {
  for (const key of ['CardDebit', 'CardCredit']) {
    if (item !== null && typeof item === 'object' && key in item) {
      return CardSchema.parse((item as Record<string, unknown>)[key]);
    }
  }
  throw new Error('Unknown card type in response');
}

// ─── Offline fallback — serves static seed when bunq sandbox is unreachable ──
function getOfflineSeedData<T>(path: string, schema: z.ZodType<T>): T {
  console.warn(`[bunq] OFFLINE_MODE: serving seed data for ${path}`);
  // Minimal fixtures that pass Zod schemas — daemon continues on seed data.
  let raw: unknown;
  if (path.includes('/monetary-account') && !path.includes('/payment') && !path.includes('/savings-goal') && !path.includes('/schedule')) {
    raw = {
      Response: [{
        MonetaryAccountBank: {
          id: 1, status: 'ACTIVE', description: 'bunq Offline — Primary',
          currency: 'EUR', balance: { value: '2500.00', currency: 'EUR' },
          alias: [{ type: 'IBAN', value: 'NL00BUNQ0123456789', name: 'BUNQSY OFFLINE USER' }],
        },
      }],
    };
  } else if (path.includes('/payment')) {
    raw = { Response: [] };
  } else if (path.includes('/card')) {
    raw = { Response: [] };
  } else if (path.includes('/savings-goal')) {
    raw = { Response: [] };
  } else if (path.includes('/schedule')) {
    raw = { Response: [] };
  } else {
    raw = { Response: [] };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // If schema still mismatches, throw a clear offline error rather than crashing with Zod issues
  throw new Error(JSON.stringify({ phase: 'client', path, status: 503, body: 'Offline mode — no seed for this endpoint' }));
}

export class BunqClient {
  private session: BunqSession;

  constructor(session: BunqSession) {
    this.session = session;
  }

  getSession(): BunqSession {
    return this.session;
  }

  async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    // SRE resilience: offline demo mode when bunq sandbox is down — serve seed data
    if (process.env.BUNQ_OFFLINE_MODE === 'true') {
      return getOfflineSeedData<T>(path, schema);
    }

    this.session = await refreshSessionIfNeeded(this.session);

    const baseUrl = getBunqBaseUrl();
    // bunq requires signing on all requests, including GETs — sign empty body
    const signature = signRequestBody('', this.session.keyPair.privateKeyPem);

    const res = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'BunqsyFinance/1.0',
        'X-Bunq-Client-Authentication': this.session.sessionToken,
        'X-Bunq-Client-Signature': signature,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        JSON.stringify({ phase: 'client', path, status: res.status, body }),
      );
    }

    const raw: unknown = await res.json();
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        JSON.stringify({ phase: 'client', error: 'bunq contract mismatch', path, issues: result.error.issues }),
      );
    }
    return result.data;
  }

  async getAccounts(): Promise<TaggedMonetaryAccount[]> {
    const data = await this.get(
      `/user/${this.session.userId}/monetary-account`,
      MonetaryAccountListResponseSchema,
    );
    return data.Response.map(extractAccountFromItem);
  }

  async getTransactions(
    accountId: number,
    count: number = 50,
    newerId?: number,
  ): Promise<Payment[]> {
    let path = `/user/${this.session.userId}/monetary-account/${accountId}/payment?count=${count}`;
    if (newerId !== undefined) {
      path += `&newer_id=${newerId}`;
    }
    const data = await this.get(path, PaymentListResponseSchema);
    return data.Response.map((item) =>
      PaymentSchema.parse((item as Record<string, unknown>)['Payment']),
    );
  }

  async getCards(): Promise<Card[]> {
    const data = await this.get(
      `/user/${this.session.userId}/card`,
      CardListResponseSchema,
    );
    return data.Response.map(extractCardFromItem);
  }

  async getSavingsGoals(accountId: number): Promise<SavingsGoal[]> {
    try {
      const data = await this.get(
        `/user/${this.session.userId}/monetary-account/${accountId}/savings-goal`,
        SavingsGoalListResponseSchema,
      );
      return data.Response.map((item) =>
        SavingsGoalSchema.parse((item as Record<string, unknown>)['SavingsGoal']),
      );
    } catch {
      return []; // endpoint may not exist on all account types — fail silently
    }
  }

  async getScheduledPayments(accountId: number): Promise<ScheduledPayment[]> {
    const data = await this.get(
      `/user/${this.session.userId}/monetary-account/${accountId}/schedule`,
      ScheduledPaymentListResponseSchema,
    );
    return data.Response.map((item) =>
      ScheduledPaymentSchema.parse((item as Record<string, unknown>)['ScheduledPayment']),
    );
  }
}
