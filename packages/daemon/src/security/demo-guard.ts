/**
 * Demo/simulation guard.
 *
 * The demo endpoints do not just "show a UI state" — they INSERT fabricated
 * transactions into the same ledger that feeds the oracle, the BUNQSY score,
 * the forecast, the P&L and the VAT return that gets filed with the tax office.
 * Only /api/demo/reset and sandbox funding were gated; salary and fraud
 * simulation were reachable in production, which is financial-record forgery.
 */

export class DemoDisabledError extends Error {
  readonly statusCode = 403;
  constructor(what: string) {
    super(`${what} is disabled outside the sandbox environment`);
    this.name = 'DemoDisabledError';
  }
}

export function isDemoAllowed(): boolean {
  if (process.env['BUNQ_ENV'] === 'production') return false;
  // Explicit opt-out for anyone running a sandbox build against real data.
  return process.env['DEMO_ENDPOINTS_ENABLED'] !== 'false';
}

export function assertDemoAllowed(what: string): void {
  if (!isDemoAllowed()) throw new DemoDisabledError(what);
}
