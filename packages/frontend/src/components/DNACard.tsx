import { useState, useEffect } from 'react';

interface DNAData {
  dnaCard: string | null;
  suggestions: string[];
  patterns: Array<{ name: string; confidence: number }>;
  completedAt: string | null;
}

export function DNACard(): React.JSX.Element {
  const [data, setData] = useState<DNAData | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchDNA(): Promise<void> {
      try {
        const res = await fetch('/api/dna');
        if (!res.ok) return;
        const json = await res.json() as DNAData;
        if (!cancelled) setData(json);
      } catch { /* daemon not running */ }
    }
    void fetchDNA();
    return () => { cancelled = true; };
  }, []);

  if (!data?.dnaCard) return <></>;

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.label}>Financial DNA</span>
        {data.completedAt && (
          <span style={styles.timestamp}>
            {new Date(data.completedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </span>
        )}
      </div>

      {/* DNA string — the 4–6 word personality phrase */}
      <div style={styles.dnaString}>
        {data.dnaCard}
      </div>

      {/* Pattern confidence bars */}
      {data.patterns.length > 0 && (
        <div style={styles.patterns}>
          {data.patterns.map((p) => (
            <div key={p.name} style={styles.patternRow}>
              <span style={styles.patternName}>{p.name}</span>
              <div style={styles.barTrack}>
                <div style={{
                  ...styles.barFill,
                  width: `${Math.round(p.confidence * 100)}%`,
                  background: confidenceColor(p.confidence),
                }} />
              </div>
              <span style={{ ...styles.patternPct, color: confidenceColor(p.confidence) }}>
                {Math.round(p.confidence * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Top suggestions */}
      {data.suggestions.length > 0 && (
        <div style={styles.suggestions}>
          <span style={styles.suggestLabel}>Recommendations</span>
          {data.suggestions.slice(0, 3).map((s, i) => (
            <div key={i} style={styles.suggestionRow}>
              <span style={styles.bulletDot} />
              <span style={styles.suggestionText}>{s}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function confidenceColor(confidence: number): string {
  if (confidence >= 0.85) return 'var(--accent-green)';
  if (confidence >= 0.65) return 'var(--accent-cyan)';
  return 'var(--hue-amber)';
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: 'var(--ink-042)',
    border: '1px solid var(--ink-080)',
    borderRadius: '22px',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    animation: 'fadeSlideUp 0.4s ease both',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    fontSize: '0.7rem',
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    color: 'var(--ink-350)',
  },
  timestamp: {
    fontSize: '0.65rem',
    color: 'var(--ink-220)',
  },
  dnaString: {
    fontSize: '1.1rem',
    fontWeight: 700,
    color: 'var(--text-strong)',
    letterSpacing: '-0.01em',
    lineHeight: 1.3,
    background: 'linear-gradient(135deg, var(--accent-cyan), var(--accent-green))',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
  },
  patterns: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '7px',
  },
  patternRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  patternName: {
    width: '130px',
    fontSize: '0.7rem',
    color: 'var(--ink-550)',
    flexShrink: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  barTrack: {
    flex: 1,
    height: '3px',
    background: 'var(--ink-070)',
    borderRadius: '2px',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: '2px',
    transition: 'width 1s cubic-bezier(0.4,0,0.2,1)',
  },
  patternPct: {
    width: '28px',
    fontSize: '0.68rem',
    fontWeight: 700,
    textAlign: 'right' as const,
    flexShrink: 0,
  },
  suggestions: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    paddingTop: '4px',
    borderTop: '1px solid var(--ink-060)',
  },
  suggestLabel: {
    fontSize: '0.65rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    color: 'var(--ink-280)',
    textTransform: 'uppercase' as const,
    marginBottom: '2px',
  },
  suggestionRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
  },
  bulletDot: {
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: 'var(--accent-cyan)',
    flexShrink: 0,
    marginTop: '5px',
  },
  suggestionText: {
    fontSize: '0.75rem',
    color: 'var(--ink-650)',
    lineHeight: 1.45,
  },
};
