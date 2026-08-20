/**
 * Execution-step validation — the last gate before money moves.
 *
 * Two attack paths converge on buildStepRequest():
 *
 *   1. LLM output. The planner accepts free-form speech and returns
 *      `payload: Record<string, unknown>`. A prompt-injected transcript (or a
 *      poisoned receipt image, which reaches the same models) can propose a
 *      PAYMENT to an arbitrary IBAN for an arbitrary amount.
 *   2. HTTP input. /api/cards/:cardId/freeze puts `cardEndpoint` straight from
 *      the request body into the bunq URL path — "../../monetary-account/1/payment"
 *      is a signed, authenticated request to an endpoint we never intended.
 *
 * Everything below is therefore validated *structurally* (zod), *semantically*
 * (IBAN shape, positive ints), and *by policy* (amount ceilings), before it is
 * allowed near a signature.
 */

import { z } from 'zod';
import type { ExecutionStep } from '@bunqsy/shared';

/** Hard ceiling for anything the agent can move without a human typing it. */
export function maxPaymentEur(): number {
  const raw = Number(process.env['MAX_PAYMENT_EUR'] ?? '500');
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
}

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Accepts 1234, "1234" — rejects "1234abc", "../x", 1.5, negatives. */
const idLike = z.union([positiveId, z.string().regex(/^\d{1,19}$/).transform(Number)])
  .pipe(positiveId);

const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('EUR');

/** ISO 13616 shape check: country + checksum + up to 30 alphanumerics. */
const iban = z.string()
  .transform((s) => s.replace(/\s+/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, 'invalid IBAN'));

/**
 * Free text that ends up in a bunq payload. Strips control characters so a
 * planner-supplied description cannot inject CRLF into anything downstream
 * (logs, MT940 exports, CSV).
 */
const safeText = (max: number) =>
  z.string()
    .transform((s) => s.replace(/[\u0000-\u001F\u007F]/g, ' ').trim())
    .pipe(z.string().min(1).max(max));

const optionalText = (max: number) =>
  z.union([safeText(max), z.undefined(), z.null().transform(() => undefined)]).optional();

const amount = z.union([z.number(), z.string().regex(/^\d+(\.\d{1,2})?$/).transform(Number)])
  .pipe(z.number().finite().positive().max(1_000_000))
  .refine((v) => v <= maxPaymentEur(), {
    message: `amount exceeds MAX_PAYMENT_EUR (${maxPaymentEur()})`,
  });

/** bunq card endpoints we are willing to address. Anything else is path injection. */
const cardEndpoint = z.enum(['card-debit', 'card-credit', 'card']).default('card-debit');

const PAYLOADS = {
  PAYMENT: z.object({
    fromAccountId: idLike,
    amount,
    currency,
    toIban: iban,
    toName: safeText(64),
    description: optionalText(140),
  }),

  SAVINGS_TRANSFER: z.object({
    fromAccountId: idLike,
    toAccountId: idLike,
    amount,
    currency,
    description: optionalText(140),
  }),

  DRAFT_PAYMENT: z.object({
    entry: z.object({
      amount: z.object({ value: z.string().regex(/^-?\d+(\.\d{1,2})?$/), currency }),
      counterparty_alias: z.object({
        type: z.enum(['IBAN', 'EMAIL', 'PHONE_NUMBER']),
        value: z.string().min(1).max(128),
        name: optionalText(64),
      }),
      description: optionalText(140),
    }).strict(),
  }),

  CANCEL_DRAFT: z.object({ draftPaymentId: idLike }),

  SANDBOX_FUND: z.object({
    accountId: idLike,
    amount: z.union([amount, z.undefined()]).optional(),
    description: optionalText(140),
  }),

  CARD_FREEZE:   z.object({ cardId: idLike, cardEndpoint }),
  CARD_UNFREEZE: z.object({ cardId: idLike, cardEndpoint }),

  CREATE_SAVINGS_GOAL: z.object({
    accountId: idLike,
    name: safeText(64),
    amount,
    currency,
  }),
} as const;

export class StepValidationError extends Error {
  readonly statusCode = 400;
  constructor(stepType: string, detail: string) {
    super(`Rejected ${stepType} step: ${detail}`);
    this.name = 'StepValidationError';
  }
}

/**
 * Validates and normalises a step payload. Returns the coerced payload
 * (numbers as numbers, IBAN upper-cased, text trimmed) — callers should use the
 * returned value, not the original.
 */
export function validateStep(step: ExecutionStep): ExecutionStep {
  const schema = PAYLOADS[step.type as keyof typeof PAYLOADS];
  if (!schema) throw new StepValidationError(String(step.type), 'unknown step type');

  // SANDBOX_FUND talks to bunq's sandbox-only "Sugar Daddy" faucet.
  if (step.type === 'SANDBOX_FUND' && process.env['BUNQ_ENV'] === 'production') {
    throw new StepValidationError(step.type, 'sandbox funding is disabled in production');
  }

  // Default-deny outbound payments.
  //
  // Every step type the daemon generates on its own is internal or defensive:
  // SAVINGS_TRANSFER between the user's own jars, CANCEL_DRAFT to block fraud,
  // SANDBOX_FUND against the faucet. PAYMENT and DRAFT_PAYMENT to a third party
  // can only originate from the LLM planner — i.e. from a transcript, which is
  // the one input an attacker can write. Money leaving the account therefore
  // requires an explicit operator opt-in, not just a confirmation click on a
  // narration the same attacker influenced.
  if ((step.type === 'PAYMENT' || step.type === 'DRAFT_PAYMENT')
      && process.env['VOICE_PAYMENTS_ENABLED'] !== 'true') {
    throw new StepValidationError(
      step.type,
      'outbound payments are disabled (set VOICE_PAYMENTS_ENABLED=true to allow agent-planned payments)',
    );
  }

  const parsed = schema.safeParse(step.payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'payload'} ${i.message}`)
      .join('; ');
    throw new StepValidationError(step.type, detail);
  }

  return { ...step, payload: parsed.data as ExecutionStep['payload'] };
}

export function validateSteps(steps: ExecutionStep[]): ExecutionStep[] {
  if (steps.length > 10) {
    throw new StepValidationError('plan', 'a plan may not contain more than 10 steps');
  }
  return steps.map(validateStep);
}

/**
 * Defence in depth for URL construction: even after validation, every value
 * interpolated into a bunq path goes through this.
 */
export function pathSegment(value: string | number): string {
  const str = String(value);
  if (!/^[A-Za-z0-9._-]+$/.test(str) || str.includes('..')) {
    throw new StepValidationError('path', `illegal path segment "${str.slice(0, 32)}"`);
  }
  return encodeURIComponent(str);
}
