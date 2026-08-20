/**
 * Security plugin — one place that decides who may talk to this daemon.
 *
 * Installed before every route so there is no "I forgot to add the guard to the
 * new endpoint" failure mode: the allow-list is explicit and small.
 *
 * Layers, in order:
 *   1. raw-body capture      — webhook signatures must verify the bytes bunq
 *                              signed, not a re-serialisation of the parsed JSON
 *   2. rate limit            — per IP, per cost class
 *   3. origin / CSRF guard   — browsers must come from an allow-listed origin
 *   4. bearer token          — everything except /api/health and /api/webhook
 *   5. response headers      — no sniffing, no framing, no caching of financial data
 *   6. error handler         — internal errors never leak bunq/LLM detail
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { getApiToken, safeEqual } from './token.js';
import { isOriginAllowed, isRefererAllowed, isStateChanging } from './origin.js';
import { classify, consume } from './rate-limit.js';

/**
 * Routes reachable without the API token. Keep this list tiny and justified —
 * security.test.ts asserts its exact contents, so adding one is a deliberate act.
 */
export const PUBLIC_PATHS = new Set([
  '/api/health',   // liveness only — no account data in the response
  '/api/webhook',  // bunq cannot send our token; authenticated by signature + source IP
]);

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact bytes of a JSON body, needed for signature verification. */
    rawBody?: string;
  }
}

function clientIp(req: FastifyRequest): string {
  // req.ip already honours trustProxy, which we only enable when TRUST_PROXY=true.
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/** True when the caller presented the API token — used to gate detail in public routes. */
export function isAuthenticated(req: FastifyRequest): boolean {
  const presented = presentedToken(req);
  return presented !== null && safeEqual(presented, getApiToken());
}

function presentedToken(req: FastifyRequest): string | null {
  const header = req.headers['x-bunqsy-token'];
  if (typeof header === 'string' && header.length > 0) return header;

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

export function registerSecurity(fastify: FastifyInstance): void {
  const token = getApiToken();

  // ── 1. Raw body capture ────────────────────────────────────────────────────
  // Fastify's default JSON parser discards the original bytes. The bunq webhook
  // signature is computed over those bytes, so JSON.stringify(req.body) can
  // never reproduce it (key order, spacing, unicode escaping all differ).
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req: FastifyRequest, body: Buffer, done) => {
      const raw = body.toString('utf8');
      req.rawBody = raw;
      if (raw.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(raw) as unknown);
      } catch {
        const err = new Error('Malformed JSON body') as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  // ── 2-4. Gate every request ────────────────────────────────────────────────
  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = (req.url.split('?')[0] ?? req.url).replace(/\/+$/, '') || '/';
    const ip = clientIp(req);

    // 2. Rate limit
    const decision = consume(ip, classify(req.method, req.url));
    if (!decision.allowed) {
      return reply
        .status(429)
        .header('retry-after', String(decision.retryAfter))
        .send({ error: 'Too many requests' });
    }

    const origin = req.headers.origin;

    // 3. Origin / CSRF.
    // Any request that carries an Origin came from a browser context. If that
    // origin is not ours we refuse it whatever the method: GET exports leak
    // data just as effectively as a POST changes it, and the dev proxy injects
    // our token onto anything it forwards — including a cross-site fetch.
    if (!isOriginAllowed(origin)) {
      req.log.warn({ origin, path }, 'request rejected: origin not allow-listed');
      return reply.status(403).send({ error: 'Origin not allowed' });
    }
    // Referer is the fallback signal for state-changing requests that arrive
    // without an Origin (old browsers, some form posts).
    if (isStateChanging(req.method) && !isRefererAllowed(req.headers.referer)) {
      req.log.warn({ path }, 'request rejected: referer not allow-listed');
      return reply.status(403).send({ error: 'Origin not allowed' });
    }

    // 4. Token
    if (PUBLIC_PATHS.has(path)) return;

    const presented = presentedToken(req);
    if (presented === null || !safeEqual(presented, token)) {
      // Logged so a burst of these is visible in the operator's terminal.
      // Never log the presented value: a near-miss token is still a secret.
      req.log.warn(
        { ip, path, method: req.method, presented: presented === null ? 'absent' : 'invalid' },
        'authentication failed',
      );
      return reply
        .status(401)
        .header('www-authenticate', 'Bearer realm="bunqsy"')
        .send({ error: 'Unauthorized' });
    }
  });

  // ── 5. Response headers ────────────────────────────────────────────────────
  fastify.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('permissions-policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    // Balances, transactions and scores must not sit in a shared/proxy cache.
    reply.header('cache-control', 'no-store');
    return payload;
  });

  // ── 6. Error handling ──────────────────────────────────────────────────────
  fastify.setErrorHandler((error: unknown, req, reply) => {
    const err = error as Error & { statusCode?: number };
    const status = err.statusCode ?? 500;
    const requestId = randomUUID();

    if (status >= 500) {
      // Full detail to the operator's log, opaque reference to the caller:
      // bunq API errors routinely echo IBANs, account ids and tokens.
      req.log.error({ err, requestId, path: req.url }, 'unhandled error');
      return reply.status(status).send({ error: 'Internal error', requestId });
    }

    req.log.warn({ err: err.message, requestId, path: req.url }, 'request rejected');
    return reply.status(status).send({ error: err.message, requestId });
  });
}
