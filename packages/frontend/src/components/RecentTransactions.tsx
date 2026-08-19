import { useState, useEffect, useCallback } from 'react';
import type { TransactionRow } from '@bunqsy/shared';

function taxCategoryLabel(cat: string): string {
  // Strip prefix and make human-readable: "BIZ_SOFTWARE" → "Software"
  return cat
    .replace(/^(BIZ_|PERSONAL_|INCOME_|TRANSFER_|TAX_)/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

const CATEGORY_ICONS: Record<string, string> = {
  groceries:     '🛒',
  dining:        '🍽️',
  transport:     '🚆',
  entertainment: '🎭',
  health:        '💊',
  shopping:      '🛍️',
  utilities:     '⚡',
  salary:        '💼',
  other:         '📦',
};

const CATEGORY_COLORS: Record<string, string> = {
  groceries:     '#1A4480',
  dining:        '#8B4513',
  transport:     '#2B5EA7',
  entertainment: '#6B21A8',
  health:        '#065F46',
  shopping:      '#92400E',
  utilities:     '#1E3A5F',
  salary:        '#1B6038',
  other:         '#374151',
};

function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

const DEFAULT_VISIBLE = 5;

interface Props {
  refreshKey?: number;
}

export function RecentTransactions({ refreshKey = 0 }: Props): React.JSX.Element {
  const [rows, setRows] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/transactions?limit=20');
      if (!res.ok) return;
      const data = await res.json() as TransactionRow[];
      setRows(data);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const visible = expanded ? rows : rows.slice(0, DEFAULT_VISIBLE);
  const hiddenCount = rows.length - DEFAULT_VISIBLE;

  const label = (tx: TransactionRow): string =>
    tx.counterparty_name?.trim() || tx.description?.trim() || `Transaction ${tx.id.slice(0, 8)}`;

  const isReceipt = (tx: TransactionRow): boolean => tx.id.startsWith('receipt-');

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>Recent Transactions</span>
        <span style={styles.count}>{loading ? '…' : `${rows.length} shown`}</span>
      </div>

      {loading && (
        <div style={styles.empty}>Loading…</div>
      )}

      {!loading && rows.length === 0 && (
        <div style={{
          ...styles.empty,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 10, padding: '28px 0 20px',
        }}>
          <span style={{ fontSize: 28 }} aria-hidden="true">🌙</span>
          <div style={{ fontSize: 13, color: 'var(--ink-550)', fontWeight: 600 }}>Your feed is quiet</div>
          <div style={{ fontSize: 11, color: 'var(--ink-320)', maxWidth: 220, textAlign: 'center', lineHeight: 1.5 }}>
            Fund the sandbox to wake up your guardian — or connect your bunq account.
          </div>
          <span style={{ fontSize: 10, color: 'var(--ink-180)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            BUNQSY is listening
          </span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {visible.map((tx, i) => {
          const cat      = tx.category ?? 'other';
          const icon     = CATEGORY_ICONS[cat] ?? '📦';
          const iconBg   = CATEGORY_COLORS[cat] ?? '#374151';
          const positive = tx.amount > 0;
          const manual   = isReceipt(tx);

          return (
            <div key={tx.id}>
              <div style={styles.row}>
                <div style={{ ...styles.iconTile, background: iconBg }}>
                  {icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'nowrap' }}>
                    <span style={styles.merchant}>{label(tx)}</span>
                    {manual && (
                      <span style={styles.manualBadge}>receipt</span>
                    )}
                    {tx.je_category && tx.je_category !== 'UNCATEGORIZED' && (
                      <span style={styles.taxBadge} title={tx.je_category}>
                        ✓ {taxCategoryLabel(tx.je_category)}
                      </span>
                    )}
                    {tx.journal_entry_id && (!tx.je_category || tx.je_category === 'UNCATEGORIZED') && (
                      <span style={styles.pendingBadge}>⏳ review</span>
                    )}
                  </div>
                  <div style={styles.meta}>
                    {relativeTime(tx.created_at)}
                    {tx.category && <> · {tx.category}</>}
                  </div>
                </div>
                <div style={{ ...styles.amount, color: positive ? 'var(--accent-green)' : 'var(--text-soft)' }}>
                  {positive ? '+' : '−'}€{Math.abs(tx.amount).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </div>
              </div>
              {i < visible.length - 1 && <div style={styles.divider} />}
            </div>
          );
        })}
      </div>

      {rows.length > DEFAULT_VISIBLE && (
        <button
          onClick={() => setExpanded(e => !e)}
          style={styles.expandBtn}
        >
          {expanded
            ? '↑ Show less'
            : `↓ Show ${hiddenCount} more transaction${hiddenCount !== 1 ? 's' : ''}`}
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: 'var(--ink-042)',
    border: '1px solid var(--ink-080)',
    borderRadius: '22px',
    padding: '20px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '14px',
  },
  title: {
    fontSize: '0.75rem',
    fontWeight: 600,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    color: 'var(--ink-320)',
  },
  count: {
    fontSize: '0.68rem',
    color: 'var(--ink-200)',
  },
  empty: {
    fontSize: '0.8rem',
    color: 'var(--ink-240)',
    textAlign: 'center' as const,
    padding: '24px 0',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '11px 0',
  },
  iconTile: {
    width: '38px',
    height: '38px',
    borderRadius: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '16px',
    flexShrink: 0,
  },
  merchant: {
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--text-strong)',
    letterSpacing: '-0.01em',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  manualBadge: {
    fontSize: '8px',
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: '4px',
    background: 'rgba(99,102,241,0.18)',
    color: '#818cf8',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    flexShrink: 0,
  },
  taxBadge: {
    fontSize: '8px',
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: '4px',
    background: 'rgba(0,191,255,0.10)',
    color: 'var(--accent-cyan)',
    letterSpacing: '0.04em',
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
    maxWidth: '90px',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
  },
  pendingBadge: {
    fontSize: '8px',
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: '4px',
    background: 'rgba(255,106,0,0.10)',
    color: 'var(--hue-orange)',
    letterSpacing: '0.04em',
    flexShrink: 0,
  },
  meta: {
    fontSize: '10px',
    color: 'var(--ink-260)',
    marginTop: '2px',
  },
  amount: {
    fontSize: '14px',
    fontWeight: 700,
    letterSpacing: '-0.02em',
    flexShrink: 0,
  },
  divider: {
    height: '1px',
    background: 'var(--ink-040)',
    marginLeft: '50px',
  },
  expandBtn: {
    width: '100%',
    marginTop: '10px',
    padding: '8px',
    background: 'transparent',
    border: '1px solid var(--ink-070)',
    borderRadius: '10px',
    color: 'var(--ink-320)',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    transition: 'border-color 0.2s, color 0.2s',
  },
};
