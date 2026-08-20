import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * The daemon's API token, read from the same file the daemon writes.
 *
 * It is injected here — in the Node process running the dev server — and never
 * shipped to the browser. That is deliberate: a token in browser JS is readable
 * by any XSS and replayable by any page that can reach localhost:3001, whereas
 * a proxy-injected header can only be obtained by something already running on
 * this machine as this user.
 */
function daemonToken(): string | null {
  if (process.env.BUNQSY_API_TOKEN) return process.env.BUNQSY_API_TOKEN.trim();
  const file = process.env.BUNQSY_TOKEN_FILE ?? resolve(__dirname, '../../.bunqsy-token');
  if (!existsSync(file)) return null;
  const value = readFileSync(file, 'utf8').trim();
  return value.length > 0 ? value : null;
}

const token = daemonToken();
if (!token) {
  console.warn(
    '[bunqsy] No .bunqsy-token found — start the daemon once to generate it, ' +
    'or set BUNQSY_API_TOKEN. API calls will return 401 until then.',
  );
}

const authHeader = token ? { 'x-bunqsy-token': token } : undefined;

/**
 * Hosts allowed to reach the dev server. `true` (allow anything) leaves the
 * dev server open to DNS rebinding: a page on the internet resolves its own
 * hostname to 127.0.0.1 and then reads source files and proxies API calls.
 * The Arena/e2b preview needs a wildcard subdomain, so it is listed explicitly.
 */
const allowedHosts = (process.env.VITE_ALLOWED_HOSTS ?? '.e2b.app,localhost,127.0.0.1')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@bunqsy/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    host: process.env.VITE_HOST ?? '0.0.0.0',
    allowedHosts,
    // Same-origin only: without this Vite answers cross-origin fetches with
    // Access-Control-Allow-Origin: *, which would let any site read responses
    // proxied through /api — including the token-authenticated ones.
    cors: false,
    fs: {
      strict: true,
      // Patterns are matched against absolute paths, so each needs a **/ prefix.
      deny: [
        '**/.env', '**/.env.*', '**/.bunqsy-token',
        '**/*.pem', '**/*.key',
        '**/*.db', '**/*.db-wal', '**/*.db-shm',
      ],
    },
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,   // preserve Origin so the daemon can CSRF-check it
        headers: authHeader,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
        changeOrigin: false,
        headers: authHeader,
      },
    },
  },
});
