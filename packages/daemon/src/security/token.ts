/**
 * Local API token — the daemon's single shared secret.
 *
 * Threat model: the daemon exposes ~37 endpoints that move money, freeze cards,
 * spend LLM credits and wipe the local database. Before this module every one of
 * them was reachable by anything that could open a TCP socket to the port
 * (OWASP A01 / A07). The token closes that.
 *
 * Zero-config by design: if BUNQSY_API_TOKEN is not set we generate one and
 * persist it to a 0600 file next to the repo root. The Vite dev proxy reads the
 * same file and injects the header server-side, so the browser never holds the
 * token and a malicious page cannot replay it (see packages/frontend/vite.config.ts).
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo-root-relative default so daemon and Vite proxy agree without config. */
export const DEFAULT_TOKEN_FILE = resolve(join(__dirname, '../../../../.bunqsy-token'));

let cached: string | null = null;

function tokenFilePath(): string {
  return process.env['BUNQSY_TOKEN_FILE']
    ? resolve(process.env['BUNQSY_TOKEN_FILE'])
    : DEFAULT_TOKEN_FILE;
}

/**
 * Returns the active API token, generating and persisting one on first boot.
 * Never log the return value.
 */
export function getApiToken(): string {
  if (cached) return cached;

  const fromEnv = process.env['BUNQSY_API_TOKEN']?.trim();
  if (fromEnv) {
    if (fromEnv.length < 16) {
      throw new Error('BUNQSY_API_TOKEN must be at least 16 characters');
    }
    cached = fromEnv;
    return cached;
  }

  const file = tokenFilePath();
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) {
      cached = existing;
      return cached;
    }
  }

  const generated = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, generated + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort on exotic filesystems */ }
  cached = generated;
  return cached;
}

/**
 * Constant-time compare.
 *
 * Comparing the raw buffers would still branch on length (timingSafeEqual
 * throws when they differ), so both sides are hashed to a fixed 32 bytes first.
 * The comparison cost is then identical for "wrong length", "wrong first byte"
 * and "wrong last byte".
 */
export function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/** For boot logs / support: first 6 chars only, never the whole secret. */
export function tokenFingerprint(token: string): string {
  return `${token.slice(0, 6)}…(${token.length} chars)`;
}

export function tokenLocationHint(): string {
  return process.env['BUNQSY_API_TOKEN'] ? 'env BUNQSY_API_TOKEN' : tokenFilePath();
}
