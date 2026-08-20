/**
 * Boot-time configuration validation.
 *
 * A financial daemon that starts successfully with an insecure configuration is
 * worse than one that refuses to start: nobody reads the warning in the scroll-
 * back three weeks later. Anything that would be a real-money incident is fatal
 * in production; everything else is a warning with the fix spelled out.
 */

export interface ConfigIssue {
  level: 'fatal' | 'warn';
  message: string;
}

function isProduction(): boolean {
  return process.env['BUNQ_ENV'] === 'production';
}

function parseUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

/** Hosts we are willing to send a signed bunq session token to. */
const BUNQ_HOSTS = ['api.bunq.com', 'public-api.sandbox.bunq.com'];

export function collectConfigIssues(env: NodeJS.ProcessEnv = process.env): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const prod = env['BUNQ_ENV'] === 'production';

  // ── The API base URL is where a signed session token gets sent ─────────────
  for (const key of ['BUNQ_PRODUCTION_URL', 'BUNQ_SANDBOX_URL'] as const) {
    const raw = env[key];
    if (!raw) continue;
    const url = parseUrl(raw);
    if (!url) {
      issues.push({ level: 'fatal', message: `${key} is not a valid URL` });
      continue;
    }
    if (url.protocol !== 'https:') {
      issues.push({ level: 'fatal', message: `${key} must use https (got ${url.protocol})` });
    }
    if (!BUNQ_HOSTS.includes(url.hostname)) {
      issues.push({
        level: prod ? 'fatal' : 'warn',
        message: `${key} points at ${url.hostname}, not a bunq host — session tokens would be sent there`,
      });
    }
  }

  // ── Webhook callback URL is published to bunq and receives account events ──
  const webhook = env['WEBHOOK_PUBLIC_URL'];
  if (webhook) {
    const url = parseUrl(webhook);
    if (!url) {
      issues.push({ level: 'fatal', message: 'WEBHOOK_PUBLIC_URL is not a valid URL' });
    } else if (url.protocol !== 'https:') {
      issues.push({
        level: prod ? 'fatal' : 'warn',
        message: 'WEBHOOK_PUBLIC_URL must be https — payment notifications would travel in clear text',
      });
    }
  }

  // ── Exposure ───────────────────────────────────────────────────────────────
  const host = env['HOST'] ?? '127.0.0.1';
  const offBox = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
  if (offBox && !env['BUNQSY_API_TOKEN']) {
    issues.push({
      level: 'warn',
      message: `HOST=${host} exposes the daemon off-box while using the auto-generated token file. ` +
               'Set BUNQSY_API_TOKEN explicitly so the token is not readable from the repo directory.',
    });
  }

  if (prod && !env['ALLOWED_ORIGINS'] && !env['FRONTEND_URL']) {
    issues.push({
      level: 'fatal',
      message: 'Production requires ALLOWED_ORIGINS (or FRONTEND_URL): with neither, every browser request is refused.',
    });
  }

  if (env['TRUST_PROXY'] === 'true' && !env['ALLOWED_ORIGINS'] && !env['FRONTEND_URL']) {
    issues.push({
      level: 'warn',
      message: 'TRUST_PROXY=true makes X-Forwarded-For authoritative — only enable it behind a proxy you control.',
    });
  }

  // ── Money limits ───────────────────────────────────────────────────────────
  const cap = env['MAX_PAYMENT_EUR'];
  if (cap !== undefined) {
    const parsed = Number(cap);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      issues.push({ level: 'fatal', message: 'MAX_PAYMENT_EUR must be a positive number' });
    } else if (parsed > 5000) {
      issues.push({ level: 'warn', message: `MAX_PAYMENT_EUR=${parsed} is a large autonomous-payment ceiling` });
    }
  }

  if (prod && env['VOICE_PAYMENTS_ENABLED'] === 'true') {
    issues.push({
      level: 'warn',
      message: 'VOICE_PAYMENTS_ENABLED=true in production: spoken instructions can create outbound payment plans. ' +
               'They still require confirmation, but the planner is prompt-injectable through transcripts.',
    });
  }

  if (prod && env['BUNQ_OFFLINE_MODE'] === 'true') {
    issues.push({ level: 'fatal', message: 'BUNQ_OFFLINE_MODE=true simulates writes — never valid in production' });
  }

  if (prod && env['LOG_TRANSCRIPTS'] === 'true') {
    issues.push({ level: 'warn', message: 'LOG_TRANSCRIPTS=true writes spoken financial instructions to the log' });
  }

  return issues;
}

/** Prints findings; throws on any fatal issue in production. */
export function assertSafeConfig(): void {
  const issues = collectConfigIssues();
  for (const issue of issues) {
    const prefix = issue.level === 'fatal' ? '[bunqsy] ✗ CONFIG' : '[bunqsy] ⚠ config';
    console[issue.level === 'fatal' ? 'error' : 'warn'](`${prefix}: ${issue.message}`);
  }

  const fatal = issues.filter((i) => i.level === 'fatal');
  if (fatal.length > 0 && isProduction()) {
    throw new Error(`Refusing to start: ${fatal.length} fatal configuration issue(s)`);
  }
}
