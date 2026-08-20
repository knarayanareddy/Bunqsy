/**
 * Origin / CSRF policy.
 *
 * The daemon is a localhost service that a browser talks to. That makes it a
 * classic CSRF and cross-site-WebSocket-hijacking target: any page the user
 * visits can POST to http://localhost:3001/api/demo/reset, or open a WebSocket
 * to /ws and read the user's live financial stream — the browser attaches no
 * credentials, but the daemon never asked for any.
 *
 * Policy:
 *   • state-changing request with an Origin header  → Origin must be allow-listed
 *   • WebSocket upgrade                             → Origin must be allow-listed
 *   • no Origin at all (curl, bunq webhook, tests)  → allowed, but the token
 *     guard still applies, so it is not a bypass for browsers
 */

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

/** Suffix entries start with a dot: ".example.com" matches any subdomain. */
function parseConfigured(): string[] {
  const raw = [
    process.env['ALLOWED_ORIGINS'],
    process.env['FRONTEND_URL'],
  ]
    .filter(Boolean)
    .join(',');

  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function allowedOrigins(): string[] {
  const configured = parseConfigured();
  // Production must be explicit: no implicit localhost trust.
  if (process.env['BUNQ_ENV'] === 'production') return configured;
  return [...DEV_ORIGINS, ...configured];
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;                 // non-browser client; token still required
  if (origin === 'null') return false;      // sandboxed iframe / file:// — never trusted

  let host: string;
  let normalised: string;
  try {
    const url = new URL(origin);
    host = url.host;
    normalised = `${url.protocol}//${url.host}`;
  } catch {
    return false;                            // malformed Origin → reject
  }

  return allowedOrigins().some((entry) => {
    if (entry.startsWith('.')) return host === entry.slice(1) || host.endsWith(entry);
    return entry === normalised;
  });
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isStateChanging(method: string): boolean {
  return STATE_CHANGING.has(method.toUpperCase());
}

/**
 * Referer is checked as a fallback for state-changing requests that arrive with
 * no Origin — some older browsers omit Origin on same-site form posts.
 */
export function isRefererAllowed(referer: string | undefined): boolean {
  if (!referer) return true;
  try {
    const url = new URL(referer);
    return isOriginAllowed(`${url.protocol}//${url.host}`);
  } catch {
    return false;
  }
}
