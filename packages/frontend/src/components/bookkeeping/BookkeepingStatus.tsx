import React, { useState, useEffect } from 'react';

interface Status {
  totalTransactions: number;
  journalEntries: number;
  uncategorized: number;
  pendingReview: number;
}

export function BookkeepingStatus({ onExportClick }: { onExportClick: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/bookkeeping/status');
        if (res.ok) setStatus(await res.json() as Status);
      } catch { /* daemon offline */ }
    })();
  }, []);

  const categorizedPct = status && status.totalTransactions > 0
    ? Math.round((status.journalEntries / status.totalTransactions) * 100)
    : 0;

  return (
    <div style={{
      background: 'var(--ink-040)', border: '1px solid var(--ink-080)',
      borderRadius: '20px', padding: '24px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <div style={sectionLabelStyle}>Bookkeeping Status</div>
          {status && (
            <div style={{ fontSize: '11px', color: 'var(--ink-350)', marginTop: '2px' }}>
              {status.journalEntries} / {status.totalTransactions} transactions categorized
            </div>
          )}
        </div>
        <button onClick={onExportClick} style={exportBtnStyle}>
          Export ↓
        </button>
      </div>

      {status && (
        <>
          {/* Progress bar */}
          <div style={{ height: '4px', background: 'var(--ink-060)', borderRadius: '4px', marginBottom: '16px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${categorizedPct}%`,
              background: categorizedPct >= 90 ? 'var(--accent-green)' : categorizedPct >= 60 ? 'var(--hue-orange)' : '#ff1500',
              borderRadius: '4px', transition: 'width 0.8s ease',
            }} />
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            {[
              { label: 'Total Transactions', value: status.totalTransactions, color: 'var(--ink-600)' },
              { label: 'Journal Entries',    value: status.journalEntries,    color: 'var(--accent-cyan)' },
              { label: 'Uncategorized',      value: status.uncategorized,     color: status.uncategorized > 0 ? 'var(--hue-orange)' : 'var(--accent-green)' },
              { label: 'Pending Review',     value: status.pendingReview,     color: status.pendingReview > 0 ? 'var(--hue-orange)' : 'var(--accent-green)' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{
                flex: 1, padding: '10px 12px',
                background: 'var(--ink-020)', border: '1px solid var(--ink-050)',
                borderRadius: '10px',
              }}>
                <div style={{ fontSize: '9px', color: 'var(--ink-300)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '4px' }}>
                  {label}
                </div>
                <div style={{ fontSize: '18px', fontWeight: 800, color, fontFamily: "'Montserrat', sans-serif" }}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {!status && (
        <div style={{ fontSize: '12px', color: 'var(--ink-250)', fontStyle: 'italic' }}>
          Connect to daemon to see status.
        </div>
      )}
    </div>
  );
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 700, letterSpacing: '0.10em',
  textTransform: 'uppercase', color: 'var(--ink-450)',
};

const exportBtnStyle: React.CSSProperties = {
  background: 'rgba(0,191,255,0.08)', border: '1px solid rgba(0,191,255,0.25)',
  borderRadius: '100px', padding: '7px 16px', color: 'var(--accent-cyan)',
  fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
};
