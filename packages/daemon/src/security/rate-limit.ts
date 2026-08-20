/**
 * Dependency-free token-bucket rate limiter.
 *
 * Deliberately not @fastify/rate-limit: this daemon runs on a laptop, the
 * threat is a single abusive client (or a runaway retry loop), and every extra
 * dependency is extra supply-chain surface on a codebase that already ships a
 * bank session key. ~60 lines beats 40 transitive packages here.
 *
 * Buckets are per client IP *and* per cost class, so a burst of receipt uploads
 * cannot starve the dashboard's polling.
 */

export type CostClass = 'read' | 'write' | 'expensive';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface Policy {
  /** Sustained refill rate, tokens per second. */
  ratePerSec: number;
  /** Burst ceiling. */
  capacity: number;
}

const POLICIES: Record<CostClass, Policy> = {
  // Every browser tab shares one bucket, because with trustProxy off all
  // proxied traffic arrives from 127.0.0.1. Sized so a few tabs polling
  // /api/accounts + /api/insights + /api/transactions cannot lock each other out.
  read:      { ratePerSec: 20,   capacity: 300 },
  // Confirms, dismissals, freezes, bookkeeping approvals.
  write:     { ratePerSec: 1,    capacity: 30 },
  // Anything that spends money at Anthropic / ElevenLabs, forks a worker, or
  // rewrites the database: voice, receipts, dream, demo reset.
  expensive: { ratePerSec: 0.15, capacity: 8 },
};

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 5_000;      // bound memory against IP-spoofed key explosion
let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < 60_000 && buckets.size < MAX_BUCKETS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > 10 * 60_000) buckets.delete(key);
  }
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

export interface RateDecision {
  allowed: boolean;
  /** Seconds the caller should wait before retrying. */
  retryAfter: number;
}

export function consume(ip: string, cls: CostClass, now = Date.now()): RateDecision {
  sweep(now);

  const policy = POLICIES[cls];
  const key = `${cls}:${ip}`;
  const bucket = buckets.get(key) ?? { tokens: policy.capacity, updatedAt: now };

  const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
  bucket.tokens = Math.min(policy.capacity, bucket.tokens + elapsedSec * policy.ratePerSec);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return { allowed: false, retryAfter: Math.ceil((1 - bucket.tokens) / policy.ratePerSec) };
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return { allowed: true, retryAfter: 0 };
}

/** Test seam. */
export function resetRateLimiter(): void {
  buckets.clear();
  lastSweep = Date.now();
}

const EXPENSIVE_PREFIXES = [
  '/api/voice',
  '/api/receipt',
  '/api/dream/trigger',
  '/api/demo/',
  '/api/bookkeeping/export',
];

export function classify(method: string, url: string): CostClass {
  const path = url.split('?')[0] ?? url;
  if (EXPENSIVE_PREFIXES.some((p) => path.startsWith(p))) return 'expensive';
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}
