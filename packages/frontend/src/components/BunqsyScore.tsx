import type { BUNQSYScore, ScoreEmotion } from '@bunqsy/shared';

interface Props {
  score: BUNQSYScore | null;
}

const RADIUS = 80;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const EMOTION_CONFIG: Record<ScoreEmotion, { label: string; color: string; glow: string }> = {
  THRIVING: { label: '✦ THRIVING', color: 'var(--accent-green)', glow: 'rgba(0,255,149,0.35)' },
  CALM:     { label: '◎ CALM',     color: 'var(--accent-cyan)', glow: 'rgba(0,191,255,0.35)' },
  ALERT:    { label: '⚡ ALERT',   color: 'var(--hue-amber)', glow: 'rgba(245,158,11,0.35)' },
  ANXIOUS:  { label: '⚠ ANXIOUS', color: '#ef4444', glow: 'rgba(239,68,68,0.35)' },
};

function trendArrow(trend: 'up' | 'down' | 'flat'): string {
  if (trend === 'up') return '↑';
  if (trend === 'down') return '↓';
  return '→';
}

function trendColor(trend: 'up' | 'down' | 'flat'): string {
  if (trend === 'up') return 'var(--color-green)';
  if (trend === 'down') return 'var(--color-red)';
  return 'var(--text-secondary)';
}

function scoreColor(score: number): string {
  if (score >= 75) return 'var(--accent-green)';
  if (score >= 50) return 'var(--hue-orange)';
  return '#ff1500';
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'EXCELLENT';
  if (score >= 60) return 'GOOD';
  if (score >= 40) return 'FAIR';
  return 'AT RISK';
}

export function BUNQSYScore({ score }: Props): React.JSX.Element {
  const value = score?.value ?? 0;
  const trend = score?.trend ?? 'flat';
  const dashOffset = CIRCUMFERENCE - (value / 100) * CIRCUMFERENCE;
  const color = scoreColor(value);

  return (
    <div className="glass" style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>BUNQSY HEALTH SCORE</span>
        {score && (
          <span style={styles.liveRow}>
            <span className="live-dot" />
            <span style={styles.liveLabel}>LIVE</span>
          </span>
        )}
      </div>

      <div style={styles.ringWrap}>
        <svg width={200} height={200} style={styles.svg}>
          <defs>
            {/* bunq rainbow spectrum — matches brand motif and reference designs */}
            <linearGradient id="rainbowRingGrad" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%"   stopColor="#ef4444" />
              <stop offset="17%"  stopColor="#f97316" />
              <stop offset="33%"  stopColor="#eab308" />
              <stop offset="50%"  stopColor="#22c55e" />
              <stop offset="67%"  stopColor="#3b82f6" />
              <stop offset="83%"  stopColor="#6366f1" />
              <stop offset="100%" stopColor="#a855f7" />
            </linearGradient>
          </defs>
          {/* Track */}
          <circle
            cx={100} cy={100} r={RADIUS}
            fill="none"
            stroke="var(--ink-070)"
            strokeWidth={10}
          />
          {/* Rainbow progress arc */}
          <circle
            cx={100} cy={100} r={RADIUS}
            fill="none"
            stroke="url(#rainbowRingGrad)"
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            style={{
              transform: 'rotate(-90deg)',
              transformOrigin: '100px 100px',
              transition: 'stroke-dashoffset 1s cubic-bezier(0.4,0,0.2,1)',
              filter: `drop-shadow(0 0 12px rgba(100,180,255,0.5))`,
            }}
          />
          {/* Score number */}
          <text
            x={100} y={90}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ fill: 'var(--text-primary)', fontSize: '2.6rem', fontWeight: 800, fontFamily: "'Montserrat', 'Inter', sans-serif" }}
          >
            {value}
          </text>
          {/* Emotion label below score */}
          <text
            x={100} y={118}
            textAnchor="middle"
            style={{ fill: color, fontSize: '0.62rem', fontWeight: 700, fontFamily: 'Inter, sans-serif', letterSpacing: '0.12em' }}
          >
            {scoreLabel(value)}
          </text>
        </svg>
      </div>

      <div style={styles.trendRow}>
        <span style={{ ...styles.trendBadge, color: trendColor(trend), borderColor: trendColor(trend) }}>
          {trendArrow(trend)} {trend.toUpperCase()}
        </span>
        {score?.emotion && (() => {
          const ec = EMOTION_CONFIG[score.emotion];
          return (
            <span style={{
              ...styles.trendBadge,
              color: ec.color,
              borderColor: ec.color,
              boxShadow: `0 0 10px ${ec.glow}`,
              animation: 'glowPulse 3s ease-in-out infinite',
            }}>
              {ec.label}
            </span>
          );
        })()}
      </div>

      {score && (
        <div style={styles.breakdown}>
          <BreakdownBar label="Balance" value={score.components.balance} />
          <BreakdownBar label="Velocity" value={score.components.velocity} />
          <BreakdownBar label="Goals" value={score.components.goals} />
          <BreakdownBar label="Upcoming" value={score.components.upcoming} />
        </div>
      )}

      {!score && (
        <div style={styles.placeholder}>
          <span style={styles.placeholderText}>Waiting for first heartbeat…</span>
        </div>
      )}
    </div>
  );
}

function BreakdownBar({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div style={barStyles.row}>
      <span style={barStyles.label}>{label}</span>
      <div style={barStyles.track}>
        <div
          style={{
            ...barStyles.fill,
            width: `${value}%`,
            background: scoreColor(value),
            transition: 'width 0.8s cubic-bezier(0.4,0,0.2,1)',
          }}
        />
      </div>
      <span style={barStyles.value}>{Math.round(value)}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    padding: '28px 24px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
    animation: 'fadeSlideUp 0.5s ease both',
  },
  header: {
    width: '100%',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: '0.75rem',
    fontWeight: 600,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    color: 'var(--text-secondary)',
  },
  liveRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  liveLabel: {
    fontSize: '0.65rem',
    letterSpacing: '0.1em',
    color: 'var(--color-green)',
    fontWeight: 600,
  },
  ringWrap: {
    position: 'relative' as const,
  },
  svg: {
    overflow: 'visible',
  },
  trendRow: {
    display: 'flex',
    justifyContent: 'center',
    gap: 8,
    flexWrap: 'wrap' as const,
  },
  trendBadge: {
    fontSize: '0.7rem',
    fontWeight: 700,
    letterSpacing: '0.1em',
    padding: '4px 10px',
    borderRadius: 20,
    border: '1px solid',
  },
  breakdown: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  placeholder: {
    padding: '16px 0',
  },
  placeholderText: {
    color: 'var(--text-muted)',
    fontSize: '0.8rem',
  },
};

const barStyles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    width: 64,
    fontSize: '0.7rem',
    color: 'var(--text-secondary)',
    flexShrink: 0,
  },
  track: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    background: 'var(--ink-080)',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 2,
  },
  value: {
    width: 24,
    fontSize: '0.7rem',
    color: 'var(--text-muted)',
    textAlign: 'right' as const,
    flexShrink: 0,
  },
};
