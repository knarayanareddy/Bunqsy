/**
 * Parse a bunq amount string ("1234.56") to a number.
 * Centralizes the repeated parseFloat(x ?? '0') pattern and guards against NaN.
 */
export function parseEur(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return isNaN(n) ? 0 : n;
}

export function parseCents(value: string | number | null | undefined): number {
  return Math.round(parseEur(value) * 100);
}

export function formatEur(cents: number): string {
  return (cents / 100).toFixed(2);
}
