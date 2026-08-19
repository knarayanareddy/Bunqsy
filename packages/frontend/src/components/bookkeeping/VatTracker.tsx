import React, { useState, useEffect, useCallback } from 'react';
import type { VatPeriod } from '@bunqsy/shared';

function statusBadge(status: VatPeriod['status']): React.JSX.Element {
  const map = {
    OPEN:    { color: 'var(--accent-cyan)', bg: 'rgba(0,191,255,0.08)',  label: 'Open' },
    FILED:   { color: 'var(--accent-green)', bg: 'rgba(0,255,149,0.08)',  label: 'Filed' },
    OVERDUE: { color: '#ff1500', bg: 'rgba(255,21,0,0.08)',   label: 'Overdue' },
  };
  const s = map[status];
  return (
    <span style={{
      fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '100px',
      background: s.bg, color: s.color, letterSpacing: '0.06em',
    }}>
      {s.label}
    </span>
  );
}

export function VatTracker(): React.JSX.Element {
  const [periods, setPeriods] = useState<VatPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [filing, setFiling]   = useState<Record<string, boolean>>({});

  const fetchPeriods = useCallback(async () => {
    try {
      const res = await fetch('/api/bookkeeping/vat');
      if (res.ok) {
        const data = await res.json() as { periods: VatPeriod[] };
        setPeriods(data.periods);
      }
    } catch { /* daemon offline */ }
    setLoading(false);
  }, []);

  useEffect(() => { void fetchPeriods(); }, [fetchPeriods]);

  async function markFiled(period: VatPeriod): Promise<void> {
    const key = `${period.year}-${period.quarter}`;
    setFiling(p => ({ ...p, [key]: true }));
    try {
      await fetch(`/api/bookkeeping/vat/${period.quarter}/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: period.year }),
      });
      await fetchPeriods();
    } catch { /* silent */ }
    setFiling(p => ({ ...p, [key]: false }));
  }

  if (loading) {
    return (
      <div style={cardStyle}>
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--ink-300)', fontSize: '13px' }}>
          Loading VAT periods…
        </div>
      </div>
    );
  }

  const currentYear = new Date().getFullYear();
  const currentPeriods = periods.filter(p => p.year === currentYear);

  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: '16px' }}>
        <div style={sectionLabelStyle}>BTW / VAT Tracker</div>
        <div style={{ fontSize: '11px', color: 'var(--ink-350)', marginTop: '2px' }}>
          Netherlands quarterly returns · {currentYear}
        </div>
      </div>

      {currentPeriods.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--ink-300)', fontStyle: 'italic', padding: '20px 0' }}>
          No VAT periods computed yet. Periods are calculated automatically.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {currentPeriods.map(p => {
            const key       = `${p.year}-${p.quarter}`;
            const isLoading = filing[key];
            return (
              <div key={key} style={{
                padding: '14px 16px',
                background: p.status === 'OVERDUE' ? 'rgba(255,21,0,0.04)' : 'var(--ink-025)',
                border: `1px solid ${p.status === 'OVERDUE' ? 'rgba(255,21,0,0.20)' : 'var(--ink-060)'}`,
                borderRadius: '14px',
                display: 'flex', flexDirection: 'column', gap: '10px',
              }}>
                {/* Quarter header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      Q{p.quarter} {p.year}
                    </span>
                    <span style={{ marginLeft: '8px', fontSize: '10px', color: 'var(--ink-300)' }}>
                      {p.periodStart} – {p.periodEnd}
                    </span>
                  </div>
                  {statusBadge(p.status)}
                </div>

                {/* VAT amounts */}
                <div style={{ display: 'flex', gap: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '9px', color: 'var(--ink-300)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '3px' }}>
                      Collected (output)
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--accent-green)' }}>
                      €{p.vatCollected.toFixed(2)}
                    </div>
                    {p.vatCollected === 0 && (
                      <div style={{ fontSize: '8px', color: 'var(--ink-220)', marginTop: 2 }}>salary exempt</div>
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '9px', color: 'var(--ink-300)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '3px' }}>Paid (input)</div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--hue-orange)' }}>€{p.vatPaid.toFixed(2)}</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    {p.vatNetDue < 0 ? (
                      <>
                        <div style={{ fontSize: '9px', color: 'rgba(0,255,149,0.7)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '3px' }}>Refund Due</div>
                        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--accent-green)' }}>
                          €{Math.abs(p.vatNetDue).toFixed(2)}
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: '9px', color: 'var(--ink-300)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '3px' }}>Net Due</div>
                        <div style={{ fontSize: '14px', fontWeight: 700, color: p.vatNetDue > 0 ? 'var(--hue-orange)' : 'var(--ink-300)' }}>
                          €{p.vatNetDue.toFixed(2)}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Due date + file button */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '10px', color: 'var(--ink-300)' }}>
                    Due: {p.dueDate}
                    {p.filedAt && <span style={{ marginLeft: '8px', color: 'var(--accent-green)' }}>Filed {p.filedAt.slice(0, 10)}</span>}
                  </div>
                  {p.status !== 'FILED' && (
                    <button
                      onClick={() => { void markFiled(p); }}
                      disabled={isLoading}
                      style={{
                        background: 'rgba(0,255,149,0.08)', border: '1px solid rgba(0,255,149,0.25)',
                        borderRadius: '100px', padding: '5px 12px', color: 'var(--accent-green)',
                        fontSize: '10px', fontWeight: 600, cursor: 'pointer',
                        opacity: isLoading ? 0.5 : 1, fontFamily: 'inherit',
                      }}
                    >
                      {isLoading ? '…' : 'Mark as Filed'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--ink-040)',
  border: '1px solid var(--ink-080)',
  borderRadius: '20px',
  padding: '24px',
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 700, letterSpacing: '0.10em',
  textTransform: 'uppercase', color: 'var(--ink-450)',
};
