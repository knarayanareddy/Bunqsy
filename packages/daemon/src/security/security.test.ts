/**
 * Security regression suite.
 *
 * Every case here is a bug that existed in this repository before the hardening
 * pass — they are written as attacks, not as unit tests, so a future refactor
 * that reopens one fails loudly.
 *
 * Run: npx tsx packages/daemon/src/security/security.test.ts
 * No DB, no bunq, no network: Fastify's inject() drives the real request pipeline.
 */

import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { PUBLIC_PATHS, registerSecurity } from './plugin.js';
import { isOriginAllowed, isRefererAllowed } from './origin.js';
import { classify, consume, resetRateLimiter } from './rate-limit.js';
import { safeEqual, tokenFingerprint } from './token.js';
import { StepValidationError, pathSegment, validateStep, validateSteps } from '../bunq/step-validation.js';
import { isAllowedOrigin } from '../bunq/webhook.js';
import { collectConfigIssues } from './config-check.js';
import { DemoDisabledError, assertDemoAllowed, isDemoAllowed } from './demo-guard.js';
import { escapeCSV, mt940Field } from '../bookkeeping/exporter.js';
import type { ExecutionStep } from '@bunqsy/shared';

const TOKEN = 'test-token-0123456789abcdef';
process.env['BUNQSY_API_TOKEN'] = TOKEN;
process.env['ALLOWED_ORIGINS'] = 'http://localhost:5173';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; })
    .catch((err: unknown) => {
      console.error(`✗ ${name}`);
      throw err;
    });
}

// ─── Origin policy ────────────────────────────────────────────────────────────

async function originTests(): Promise<void> {
  await check('allow-listed origin passes', () => {
    assert.equal(isOriginAllowed('http://localhost:5173'), true);
  });

  await check('unknown origin is rejected', () => {
    assert.equal(isOriginAllowed('https://evil.example.com'), false);
  });

  await check('"null" origin (sandboxed iframe, file://) is rejected', () => {
    assert.equal(isOriginAllowed('null'), false);
  });

  await check('prefix-confusion origin is rejected', () => {
    // Naive startsWith/includes checks fall for these.
    assert.equal(isOriginAllowed('http://localhost:5173.evil.com'), false);
    assert.equal(isOriginAllowed('http://evil.com/?http://localhost:5173'), false);
    assert.equal(isOriginAllowed('http://localhost:51730'), false);
  });

  await check('malformed origin is rejected', () => {
    assert.equal(isOriginAllowed('not-a-url'), false);
  });

  await check('absent origin is allowed (non-browser client, token still required)', () => {
    assert.equal(isOriginAllowed(undefined), true);
  });

  await check('referer from a foreign site is rejected', () => {
    assert.equal(isRefererAllowed('https://evil.example.com/page'), false);
    assert.equal(isRefererAllowed('http://localhost:5173/dashboard'), true);
  });

  await check('suffix entries match subdomains only', () => {
    process.env['ALLOWED_ORIGINS'] = '.trusted.example';
    assert.equal(isOriginAllowed('https://app.trusted.example'), true);
    assert.equal(isOriginAllowed('https://trusted.example'), true);
    assert.equal(isOriginAllowed('https://nottrusted.example'), false);
    assert.equal(isOriginAllowed('https://trusted.example.evil.com'), false);
    process.env['ALLOWED_ORIGINS'] = 'http://localhost:5173';
  });

  await check('production drops the implicit localhost allow-list', () => {
    process.env['BUNQ_ENV'] = 'production';
    delete process.env['ALLOWED_ORIGINS'];
    assert.equal(isOriginAllowed('http://localhost:5173'), false);
    delete process.env['BUNQ_ENV'];
    process.env['ALLOWED_ORIGINS'] = 'http://localhost:5173';
  });
}

// ─── Token comparison ─────────────────────────────────────────────────────────

async function tokenTests(): Promise<void> {
  await check('safeEqual accepts an exact match and rejects near-misses', () => {
    assert.equal(safeEqual(TOKEN, TOKEN), true);
    assert.equal(safeEqual(TOKEN, TOKEN + 'x'), false);
    assert.equal(safeEqual(TOKEN, TOKEN.slice(0, -1) + 'X'), false);
    assert.equal(safeEqual('', TOKEN), false);
  });

  await check('fingerprint never contains the whole secret', () => {
    const fp = tokenFingerprint(TOKEN);
    assert.ok(!fp.includes(TOKEN));
    assert.ok(fp.startsWith(TOKEN.slice(0, 6)));
  });
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

async function rateLimitTests(): Promise<void> {
  await check('expensive endpoints are classified as expensive', () => {
    assert.equal(classify('POST', '/api/voice'), 'expensive');
    assert.equal(classify('POST', '/api/receipt'), 'expensive');
    assert.equal(classify('POST', '/api/demo/reset'), 'expensive');
    assert.equal(classify('GET',  '/api/score'), 'read');
    assert.equal(classify('POST', '/api/dismiss/x'), 'write');
    // Query strings must not smuggle a path past the classifier.
    assert.equal(classify('POST', '/api/voice?x=1'), 'expensive');
  });

  await check('burst is capped and then refills over time', () => {
    resetRateLimiter();
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 40; i++) {
      if (consume('1.2.3.4', 'expensive', now).allowed) allowed++;
    }
    assert.equal(allowed, 8, 'expensive burst capacity');

    const blocked = consume('1.2.3.4', 'expensive', now);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfter > 0);

    // A different client is unaffected by the first one's burst.
    assert.equal(consume('5.6.7.8', 'expensive', now).allowed, true);

    // ...and the bucket refills.
    assert.equal(consume('1.2.3.4', 'expensive', now + 60_000).allowed, true);
    resetRateLimiter();
  });
}

// ─── Execution-step validation (the write gateway) ────────────────────────────

function step(type: string, payload: Record<string, unknown>): ExecutionStep {
  return { id: 'step-1', type, description: 'test', payload } as unknown as ExecutionStep;
}

async function stepTests(): Promise<void> {
  await check('outbound payments are denied unless explicitly enabled', () => {
    delete process.env['VOICE_PAYMENTS_ENABLED'];
    // The only producer of PAYMENT/DRAFT_PAYMENT steps is the LLM planner, whose
    // input is a transcript — the one attacker-writable channel into the system.
    assert.throws(() => validateStep(step('PAYMENT', {
      fromAccountId: 1, amount: 10, currency: 'EUR',
      toIban: 'NL91ABNA0417164300', toName: 'Sarah',
    })), StepValidationError);
    assert.throws(() => validateStep(step('DRAFT_PAYMENT', {
      entry: {
        amount: { value: '10.00', currency: 'EUR' },
        counterparty_alias: { type: 'IBAN', value: 'NL91ABNA0417164300', name: 'Sarah' },
        description: 'x',
      },
    })), StepValidationError);
    // Internal money movement between the user's own jars is unaffected.
    assert.doesNotThrow(() => validateStep(step('SAVINGS_TRANSFER', {
      fromAccountId: 1, toAccountId: 2, amount: 50, currency: 'EUR',
    })));
    process.env['VOICE_PAYMENTS_ENABLED'] = 'true';
  });

  await check('card endpoint path injection is rejected', () => {
    assert.throws(
      () => validateStep(step('CARD_FREEZE', {
        cardId: 1,
        cardEndpoint: '../../monetary-account/1/payment',
      })),
      StepValidationError,
    );
  });

  await check('non-numeric card id is rejected', () => {
    assert.throws(() => validateStep(step('CARD_FREEZE', { cardId: '1/../../x', cardEndpoint: 'card-debit' })), StepValidationError);
    assert.throws(() => validateStep(step('CARD_FREEZE', { cardId: -1, cardEndpoint: 'card-debit' })), StepValidationError);
  });

  await check('valid card freeze passes and coerces the id', () => {
    const out = validateStep(step('CARD_FREEZE', { cardId: '42', cardEndpoint: 'card-credit' }));
    assert.equal((out.payload as Record<string, unknown>)['cardId'], 42);
  });

  await check('payment above MAX_PAYMENT_EUR is rejected', () => {
    process.env['MAX_PAYMENT_EUR'] = '500';
    assert.throws(() => validateStep(step('PAYMENT', {
      fromAccountId: 1, amount: 25_000, currency: 'EUR',
      toIban: 'NL91ABNA0417164300', toName: 'Attacker',
    })), StepValidationError);
  });

  await check('payment to a malformed IBAN is rejected', () => {
    assert.throws(() => validateStep(step('PAYMENT', {
      fromAccountId: 1, amount: 10, currency: 'EUR',
      toIban: 'not-an-iban', toName: 'x',
    })), StepValidationError);
  });

  await check('valid payment normalises IBAN spacing and strips control chars', () => {
    const out = validateStep(step('PAYMENT', {
      fromAccountId: '7', amount: '12.50', currency: 'eur',
      toIban: 'nl91 abna 0417 1643 00', toName: 'Sarah\nBCC: attacker',
      description: 'coffee\r\nX-Injected: 1',
    }));
    const p = out.payload as Record<string, unknown>;
    assert.equal(p['toIban'], 'NL91ABNA0417164300');
    assert.equal(p['currency'], 'EUR');
    assert.equal(p['amount'], 12.5);
    assert.ok(!String(p['toName']).includes('\n'));
    assert.ok(!String(p['description']).includes('\r'));
  });

  await check('unknown step types are rejected', () => {
    assert.throws(() => validateStep(step('DROP_TABLE', {})), StepValidationError);
  });

  await check('sandbox funding is refused in production', () => {
    process.env['BUNQ_ENV'] = 'production';
    assert.throws(() => validateStep(step('SANDBOX_FUND', { accountId: 1 })), StepValidationError);
    delete process.env['BUNQ_ENV'];
  });

  await check('plans are capped in length', () => {
    const many = Array.from({ length: 11 }, () => step('CANCEL_DRAFT', { draftPaymentId: 1 }));
    assert.throws(() => validateSteps(many), StepValidationError);
  });

  await check('pathSegment refuses traversal and separators', () => {
    assert.equal(pathSegment(42), '42');
    assert.throws(() => pathSegment('../x'), StepValidationError);
    assert.throws(() => pathSegment('a/b'), StepValidationError);
    assert.throws(() => pathSegment('a b'), StepValidationError);
  });
}

// ─── Webhook source-IP allow-list ─────────────────────────────────────────────

async function webhookIpTests(): Promise<void> {
  await check('production allows bunq CIDR, rejects everything else', () => {
    process.env['BUNQ_ENV'] = 'production';
    assert.equal(isAllowedOrigin('185.40.108.1'), true);
    assert.equal(isAllowedOrigin('185.40.111.254'), true);
    assert.equal(isAllowedOrigin('185.40.112.1'), false);
    assert.equal(isAllowedOrigin('8.8.8.8'), false);
  });

  await check('IPv4-mapped IPv6 peers are understood, junk is not', () => {
    // Dual-stack Node reports "::ffff:185.40.108.7"; the old parser turned every
    // non-dotted value into 0.0.0.0.
    assert.equal(isAllowedOrigin('::ffff:185.40.108.7'), true);
    assert.equal(isAllowedOrigin('[::ffff:185.40.108.7]'), true);
    assert.equal(isAllowedOrigin('::1'), false);
    assert.equal(isAllowedOrigin(''), false);
    assert.equal(isAllowedOrigin('999.999.999.999'), false);
    assert.equal(isAllowedOrigin('185.40.108.1.evil.com'), false);
    delete process.env['BUNQ_ENV'];
  });
}

// ─── Spreadsheet / statement export injection ─────────────────────────────────

async function exportTests(): Promise<void> {
  await check('CSV formulas from merchant names are neutralised', () => {
    for (const payload of ['=1+1', '+1', '-1', '@SUM(A1)', '\t=cmd']) {
      assert.ok(escapeCSV(payload).startsWith("'") || escapeCSV(payload).startsWith('"\''),
        `not neutralised: ${payload}`);
    }
    assert.equal(escapeCSV('Albert Heijn'), 'Albert Heijn');
    assert.equal(escapeCSV('a,b'), '"a,b"');
    assert.equal(escapeCSV('say "hi"'), '"say ""hi"""');
  });

  await check('CSV values cannot forge a new row', () => {
    const out = escapeCSV('legit\r\n=EVIL()');
    assert.ok(out.startsWith('"') && out.endsWith('"'), 'newline must be quoted');
  });

  await check('MT940 fields cannot forge a record', () => {
    assert.equal(mt940Field('ACME\r\n:61:2401'), 'ACME :61:2401'.replace(/:/g, ' ').replace(/\s+/g, ' ').trim());
    assert.ok(!mt940Field('a\nb').includes('\n'));
  });
}

// ─── Deployment configuration ─────────────────────────────────────────────────

async function configTests(): Promise<void> {
  const prodBase = {
    BUNQ_ENV: 'production',
    ALLOWED_ORIGINS: 'https://dash.example.com',
    BUNQ_PRODUCTION_URL: 'https://api.bunq.com/v1',
  } as NodeJS.ProcessEnv;

  await check('a sane production config raises nothing fatal', () => {
    const fatal = collectConfigIssues(prodBase).filter((i) => i.level === 'fatal');
    assert.deepEqual(fatal, []);
  });

  await check('plaintext or off-brand bunq URLs are fatal', () => {
    const a = collectConfigIssues({ ...prodBase, BUNQ_PRODUCTION_URL: 'http://api.bunq.com/v1' });
    assert.ok(a.some((i) => i.level === 'fatal' && i.message.includes('https')));

    const b = collectConfigIssues({ ...prodBase, BUNQ_PRODUCTION_URL: 'https://evil.example.com/v1' });
    assert.ok(b.some((i) => i.level === 'fatal' && i.message.includes('not a bunq host')));
  });

  await check('production without an origin allow-list is fatal', () => {
    const issues = collectConfigIssues({ BUNQ_ENV: 'production', BUNQ_PRODUCTION_URL: 'https://api.bunq.com/v1' });
    assert.ok(issues.some((i) => i.level === 'fatal' && i.message.includes('ALLOWED_ORIGINS')));
  });

  await check('simulated writes are fatal in production', () => {
    const issues = collectConfigIssues({ ...prodBase, BUNQ_OFFLINE_MODE: 'true' });
    assert.ok(issues.some((i) => i.level === 'fatal' && i.message.includes('OFFLINE')));
  });

  await check('a plaintext webhook URL is fatal in production, a warning in sandbox', () => {
    const prod = collectConfigIssues({ ...prodBase, WEBHOOK_PUBLIC_URL: 'http://x.example.com' });
    assert.ok(prod.some((i) => i.level === 'fatal' && i.message.includes('WEBHOOK_PUBLIC_URL')));

    const sandbox = collectConfigIssues({ BUNQ_ENV: 'sandbox', WEBHOOK_PUBLIC_URL: 'http://x.example.com' });
    assert.ok(sandbox.some((i) => i.level === 'warn' && i.message.includes('WEBHOOK_PUBLIC_URL')));
    assert.ok(!sandbox.some((i) => i.level === 'fatal'));
  });

  await check('a nonsense payment ceiling is fatal', () => {
    const issues = collectConfigIssues({ ...prodBase, MAX_PAYMENT_EUR: 'lots' });
    assert.ok(issues.some((i) => i.level === 'fatal' && i.message.includes('MAX_PAYMENT_EUR')));
  });
}

// ─── Demo / simulation guard ──────────────────────────────────────────────────

async function demoGuardTests(): Promise<void> {
  await check('simulation endpoints are refused in production', () => {
    process.env['BUNQ_ENV'] = 'production';
    // These INSERT fabricated transactions into the ledger that feeds the VAT
    // return — forging them in production is a records-integrity incident.
    assert.equal(isDemoAllowed(), false);
    assert.throws(() => assertDemoAllowed('Salary simulation'), DemoDisabledError);
    delete process.env['BUNQ_ENV'];
  });

  await check('simulation endpoints work in sandbox and can be opted out', () => {
    process.env['BUNQ_ENV'] = 'sandbox';
    assert.equal(isDemoAllowed(), true);
    process.env['DEMO_ENDPOINTS_ENABLED'] = 'false';
    assert.equal(isDemoAllowed(), false);
    delete process.env['DEMO_ENDPOINTS_ENABLED'];
    delete process.env['BUNQ_ENV'];
  });
}

// ─── Full request pipeline ────────────────────────────────────────────────────

async function pipelineTests(): Promise<void> {
  resetRateLimiter();
  const app = Fastify({ logger: false });
  registerSecurity(app);
  app.get('/api/score', async () => ({ score: 72 }));
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.post('/api/dismiss/:id', async () => ({ ok: true }));
  app.post('/api/webhook', async (req) => ({ raw: req.rawBody ?? null }));
  app.get('/api/boom', async () => { throw new Error('bunq said: IBAN NL91ABNA0417164300 rejected'); });
  await app.ready();

  await check('unauthenticated request is refused', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/score' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'Unauthorized');
  });

  await check('wrong token is refused', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/score', headers: { 'x-bunqsy-token': 'nope' } });
    assert.equal(res.statusCode, 401);
  });

  await check('valid token passes, via header or bearer', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/score', headers: { 'x-bunqsy-token': TOKEN } });
    const b = await app.inject({ method: 'GET', url: '/api/score', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
  });

  await check('the unauthenticated surface is exactly two routes', () => {
    // Tripwire: widening this set must be a conscious edit here as well.
    assert.deepEqual([...PUBLIC_PATHS].sort(), ['/api/health', '/api/webhook']);
  });

  await check('health stays public for liveness probes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
  });

  await check('cross-site POST is refused even with a valid token (CSRF)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dismiss/abc',
      headers: { origin: 'https://evil.example.com', 'x-bunqsy-token': TOKEN },
    });
    assert.equal(res.statusCode, 403);
  });

  await check('cross-site GET is refused as well (proxy-injected token cannot be borrowed)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/score',
      headers: { origin: 'https://evil.example.com', 'x-bunqsy-token': TOKEN },
    });
    assert.equal(res.statusCode, 403);
  });

  await check('same-origin POST with token succeeds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dismiss/abc',
      headers: { origin: 'http://localhost:5173', 'x-bunqsy-token': TOKEN },
    });
    assert.equal(res.statusCode, 200);
  });

  await check('security headers are present on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  await check('raw body is preserved byte-for-byte for signature checks', async () => {
    // Whitespace + escaped unicode: JSON.stringify(JSON.parse(body)) !== body,
    // which is exactly why the old signature check could never verify.
    const body = '{ "b" : 1,\n  "a" : "\\u00fc" }';
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhook',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().raw, body);
    assert.notEqual(JSON.stringify(JSON.parse(body)), body, 'test premise: re-serialisation differs');
  });

  await check('malformed JSON is a 400, not a 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhook',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    assert.equal(res.statusCode, 400);
  });

  await check('internal errors do not leak detail to the caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/boom', headers: { 'x-bunqsy-token': TOKEN } });
    assert.equal(res.statusCode, 500);
    const body = res.json();
    assert.equal(body.error, 'Internal error');
    assert.ok(typeof body.requestId === 'string' && body.requestId.length > 0);
    assert.ok(!JSON.stringify(body).includes('NL91ABNA'));
  });

  await check('rate limiter returns 429 with Retry-After', async () => {
    resetRateLimiter();
    let last = await app.inject({ method: 'GET', url: '/api/health' });
    for (let i = 0; i < 500 && last.statusCode !== 429; i++) {
      last = await app.inject({ method: 'GET', url: '/api/health' });
    }
    assert.equal(last.statusCode, 429);
    assert.ok(last.headers['retry-after']);
    resetRateLimiter();
  });

  await app.close();
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await originTests();
  await tokenTests();
  await rateLimitTests();
  await stepTests();
  await webhookIpTests();
  await exportTests();
  await configTests();
  await demoGuardTests();
  await pipelineTests();
  console.log(`✓ security suite: ${passed} checks passed`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
