/**
 * Request-input schemas.
 *
 * Fastify hands route handlers `any`-shaped params, query and body. Everything
 * below turns that into typed, bounded values at the edge, so no route has to
 * remember to sanitise before it hits SQLite, a bunq URL or a response header.
 */

import { z } from 'zod';

export const UuidParam = z.string().uuid();

/** Intervention ids are uuids, but demo/simulated ones use readable prefixes. */
export const IdParam = z.string().min(1).max(80).regex(/^[A-Za-z0-9_:.-]+$/);

export const PositiveIntParam = z.string().regex(/^\d{1,19}$/).transform(Number)
  .pipe(z.number().int().positive());

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const YearParam = z.coerce.number().int().min(2000).max(2100);
export const QuarterParam = z.coerce.number().int().min(1).max(4);

export const LimitQuery = z.coerce.number().int().min(1).max(100).catch(30);

export const CardActionBody = z.object({
  cardEndpoint:   z.enum(['card-debit', 'card-credit', 'card']).default('card-debit'),
  nameOnCard:     z.string().max(64).optional(),
  lastFourDigits: z.string().regex(/^[0-9*·]{1,4}$/).optional(),
}).strip();

export const ConfirmBody = z.object({
  action: z.enum(['allow', 'block']).default('block'),
}).strip();

export const SpeakBody = z.object({
  // ElevenLabs bills per character: cap the blast radius of a single call.
  text: z.string().trim().min(1).max(1000),
}).strip();

export class InputError extends Error {
  readonly statusCode = 400;
  constructor(what: string, detail: string) {
    super(`Invalid ${what}: ${detail}`);
    this.name = 'InputError';
  }
}

/** Parse or throw a 400 — never a 500 — with a message safe to return. */
export function parseOr400<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  what: string,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InputError(what, result.error.issues.map((i) => i.message).join('; '));
  }
  return result.data as z.infer<T>;
}

/**
 * Content-Disposition filenames are attacker-reachable through export query
 * params. Anything outside this set can break out of the quoted string or
 * inject a header line.
 */
export function safeFilenamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'export';
}
