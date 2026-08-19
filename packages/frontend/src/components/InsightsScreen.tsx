import { useState, useEffect, useCallback } from 'react';
import type { WSState } from '../hooks/useWebSocket.js';
import type { DreamBriefingType } from './DreamBriefing.js';
import type { ForecastPoint, InterventionRow, AccountSummary, OracleVote } from '@bunqsy/shared';
import { useForecast } from '../hooks/useForecast.js';

// ─── Data types ───────────────────────────────────────────────────────────────

interface WeekDay { day: string; amount: number }

interface Goal {
  name: string;
  targetAmount: number;
  currentAmount: number;
}

interface DreamSession {
  briefingText: string;
  dnaCard: string | null;
  suggestions: string[];
  completedAt: string;
  patternsUpdated: number;
  patternsCreated: number;
}

interface Kpis {
  savingRate: number;
  savingRateDelta: number;
  burnRateDaily: number;
  totalIncome30d: number;
  totalExpenses30d: number;
}

interface InsightsData {
  weeklySpending: WeekDay[];
  goals: Goal[];
  dreamSession: DreamSession | null;
  kpis: Kpis | null;
}

export interface InsightsProps {
  ws: WSState;
  dreamBriefing: DreamBriefingType | null;
  accountSummaries: AccountSummary[];
  onConfirmPlan: (planId: string) => Promise<void>;
  onDismissIntervention: (id: string) => void;
}

const PIE_DEMO_DATA = [
  { label: 'Rent & Bills',  amount: 950.00, icon: '🏠' },
  { label: 'Dining Out',    amount: 284.50, icon: '🍽️' },
  { label: 'Groceries',     amount: 178.24, icon: '🛒' },
  { label: 'Subscriptions', amount: 95.97,  icon: '🔄' },
];

// ─── Metadata maps ────────────────────────────────────────────────────────────

const AGENT_META: Record<string, { title: string; icon: string; color: string; bg: string }> = {
  'subscription-watcher': { title: 'Spending Leak Found',     icon: '🔍', color: '#EF4444', bg: 'rgba(239,68,68,0.10)' },
  'velocity-analyzer':    { title: 'Spending Spike Detected', icon: '⚡', color: 'var(--hue-amber)', bg: 'rgba(245,158,11,0.10)' },
  'balance-sentinel':     { title: 'Balance Alert',           icon: '⚖️', color: '#3b82f6', bg: 'rgba(59,130,246,0.10)' },
  'fraud-shadow':         { title: 'Suspicious Activity',     icon: '🛡️', color: '#DC2626', bg: 'rgba(220,38,38,0.10)' },
  'pattern-matcher':      { title: 'Pattern Detected',        icon: '🔮', color: '#8B5CF6', bg: 'rgba(139,92,246,0.10)' },
  'jar-optimizer':        { title: 'Savings Opportunity',     icon: '🐷', color: 'var(--hue-emerald)', bg: 'rgba(16,185,129,0.10)' },
  'rent-proximity-guard': { title: 'Rent Due Soon',           icon: '🏠', color: 'var(--hue-orange)', bg: 'rgba(249,115,22,0.10)' },
};

const ALL_AGENTS: Array<{ id: string; label: string; icon: string; color: string }> = [
  { id: 'balance-sentinel',     label: 'Balance Sentinel',     icon: '⚖️', color: '#3b82f6' },
  { id: 'velocity-analyzer',    label: 'Velocity Analyzer',    icon: '⚡', color: 'var(--hue-green)' },
  { id: 'pattern-matcher',      label: 'Pattern Matcher',      icon: '🔮', color: '#8b5cf6' },
  { id: 'subscription-watcher', label: 'Subscription Watcher', icon: '🔍', color: '#ef4444' },
  { id: 'rent-proximity-guard', label: 'Rent Guard',           icon: '🏠', color: 'var(--hue-orange)' },
  { id: 'fraud-shadow',         label: 'Fraud Shadow',         icon: '🛡️', color: '#dc2626' },
  { id: 'jar-optimizer',        label: 'Jar Optimizer',        icon: '🐷', color: 'var(--hue-emerald)' },
];

const ACTION_META: Record<string, { title: string; icon: string; color: string }> = {
  'JAR_SWEEP':      { title: 'Auto-Round Up',            icon: '🐷', color: 'var(--hue-emerald)' },
  'SALARY':         { title: 'Invest Spare Cash',         icon: '🏦', color: 'var(--hue-amber)' },
  'SUBSCRIPTION':   { title: 'Consolidate Subscriptions', icon: '📺', color: '#8B5CF6' },
  'DREAM':          { title: 'Apply Dream Suggestion',    icon: '✨', color: 'var(--accent-cyan)' },
  'BALANCE_LOW':    { title: 'Top Up Balance',            icon: '💰', color: '#EF4444' },
  'BALANCE_CRITICAL':{ title: 'Critical: Top Up Now',    icon: '🚨', color: '#DC2626' },
  'VELOCITY_SPIKE': { title: 'Review Spending',          icon: '⚡', color: 'var(--hue-amber)' },
  'FRAUD':          { title: 'Block Suspicious Tx',       icon: '🛡️', color: '#DC2626' },
};

const FEED_TYPE_META: Record<string, { icon: string; color: string }> = {
  'FRAUD':           { icon: '⚠️', color: '#ef4444' },
  'FREEZE_CARD':     { icon: '❄️', color: '#3b82f6' },
  'SUBSCRIPTION':    { icon: '🔄', color: '#8b5cf6' },
  'BALANCE_LOW':     { icon: '💰', color: 'var(--hue-amber)' },
  'BALANCE_CRITICAL':{ icon: '🚨', color: '#dc2626' },
  'VELOCITY_SPIKE':  { icon: '⚡', color: 'var(--hue-amber)' },
  'JAR_SWEEP':       { icon: '🐷', color: 'var(--hue-emerald)' },
  'SALARY':          { icon: '💼', color: 'var(--hue-green)' },
  'DREAM':           { icon: '🌙', color: 'var(--accent-cyan)' },
};

const ACCOUNT_CLASS_COLOR: Record<string, string> = {
  primary: '#3b82f6',
  savings: 'var(--hue-green)',
  joint:   'var(--hue-amber)',
  other:   '#64748b',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h    = Math.floor(diff / 3_600_000);
  const m    = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ago`;
  if (h > 0)   return `${h}h ${m}m ago`;
  if (m > 0)   return `${m}m ago`;
  return 'Just now';
}

function fmt(amount: number): string {
  return `€${amount.toFixed(0)}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DreamHeroCard({ dream, dreamBriefing }: { dream: DreamSession | null; dreamBriefing: DreamBriefingType | null }): React.JSX.Element {
  const active = dreamBriefing ?? (dream ? {
    briefingText: dream.briefingText,
    dnaCard:      dream.dnaCard ?? '',
    suggestions:  dream.suggestions,
    completedAt:  dream.completedAt,
    sessionId:    '',
  } : null);

  if (!active) {
    return (
      <div style={card.wrap}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', padding: '28px 0' }}>
          <span style={{ fontSize: 36 }}>🌙</span>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>No Dream Analysis Yet</div>
          <div style={{ fontSize: 12, color: 'var(--ink-400)', textAlign: 'center', maxWidth: 260 }}>
            Run Dream Mode tonight to get AI-powered insights on your spending patterns while you sleep.
          </div>
        </div>
      </div>
    );
  }

  const firstSentence = active.briefingText.split(/[.!?]/)[0] ?? active.briefingText;
  const optimisations = active.suggestions.length;
  const updatedAgo    = timeAgo(active.completedAt);

  // Estimate savings from suggestions: each suggestion saves ~€14/week on average
  const estimatedSavings = (optimisations * 14).toFixed(2);

  return (
    <div style={{
      ...card.wrap,
      background: 'var(--panel-cyan-grad)',
      border:     '1px solid rgba(0,191,255,0.18)',
      position:   'relative', overflow: 'hidden',
    }}>
      {/* Background glow */}
      <div style={{
        position: 'absolute', top: -40, right: -40, width: 200, height: 200,
        borderRadius: '50%', background: 'rgba(0,191,255,0.06)', pointerEvents: 'none',
      }} />

      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--accent-cyan)' }}>
          Dream Mode
        </div>
        <div style={{ fontSize: 10, color: 'var(--ink-280)' }}>Updated {updatedAgo}</div>
      </div>

      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em', lineHeight: 1.15, marginBottom: 8 }}>
        Last Night's Analysis
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-550)', lineHeight: 1.55, marginBottom: 18 }}>
        {firstSentence}. We identified <strong style={{ color: 'var(--accent-cyan)' }}>{optimisations} key optimisations</strong> for your weekly budget.
      </div>

      {/* Stat tiles — now 3: savings + optimisations + patterns */}
      <div style={{ display: 'flex', gap: 10 }}>
        {/* Saved in Sleep tile */}
        <div style={{
          flex: 1, padding: '12px 14px', borderRadius: 14,
          background: 'var(--panel-cyan-soft)',
          border: '1px solid rgba(0,191,255,0.18)',
          display: 'flex', flexDirection: 'column', gap: 3,
        }}>
          <span style={{ fontSize: 16 }}>✦</span>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--accent-cyan)', letterSpacing: '-0.02em' }}>
            €{estimatedSavings}
          </div>
          <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--ink-350)', letterSpacing: '0.10em', textTransform: 'uppercase' }}>
            Saved in Sleep
          </div>
        </div>
        {/* Patterns tile */}
        <div style={{
          flex: 1, padding: '12px 14px', borderRadius: 14,
          background: 'var(--panel-green-soft)',
          border: '1px solid rgba(0,255,149,0.15)',
          display: 'flex', flexDirection: 'column', gap: 3,
        }}>
          <span style={{ fontSize: 16 }}>🌙</span>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--accent-green)', letterSpacing: '-0.02em' }}>
            {(dream?.patternsUpdated ?? 0) + (dream?.patternsCreated ?? 0)} patterns
          </div>
          <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--ink-350)', letterSpacing: '0.10em', textTransform: 'uppercase' }}>
            Learned
          </div>
        </div>
      </div>

      {/* DNA */}
      {active.dnaCard && (
        <div style={{ marginTop: 14, padding: '8px 12px', borderRadius: 10, background: 'rgba(0,191,255,0.06)', border: '1px solid rgba(0,191,255,0.12)' }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--accent-cyan)', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Financial DNA · </span>
          <span style={{ fontSize: 11, color: 'var(--ink-650)' }}>{active.dnaCard}</span>
        </div>
      )}
    </div>
  );
}

function SpendingBarsChart({ data }: { data: WeekDay[] }): React.JSX.Element {
  const today  = new Date().getDay(); // 0=Sun
  const labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const todayLabel = labels[today === 0 ? 6 : today - 1];
  const maxAmt = Math.max(...data.map(d => d.amount), 1);

  return (
    <div style={card.wrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div>
          <div style={card.title}>Spending Patterns</div>
          <div style={card.subtitle}>Last 7 days</div>
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#3b82f6' }} />
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ink-150)' }} />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 120 }}>
        {data.map((d) => {
          const isToday = d.day === todayLabel;
          const pct     = maxAmt > 0 ? (d.amount / maxAmt) : 0;
          const minH    = d.amount > 0 ? 6 : 3;
          return (
            <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
              <div style={{
                width: '100%', borderRadius: '5px 5px 3px 3px',
                height: `${Math.max(pct * 100, minH)}%`,
                background: isToday
                  ? 'linear-gradient(180deg, #3b82f6 0%, #1d4ed8 100%)'
                  : 'var(--ink-100)',
                boxShadow: isToday ? '0 0 14px rgba(59,130,246,0.45)' : 'none',
                transition: 'height 0.8s cubic-bezier(0.4,0,0.2,1)',
                position: 'relative',
              }}>
                {d.amount > 0 && (
                  <div style={{
                    position: 'absolute', top: -18, left: '50%', transform: 'translateX(-50%)',
                    fontSize: 8, fontWeight: 700, color: isToday ? '#60a5fa' : 'var(--ink-350)',
                    whiteSpace: 'nowrap',
                  }}>
                    {fmt(d.amount)}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 9, color: isToday ? '#3b82f6' : 'var(--ink-280)', fontWeight: isToday ? 700 : 400 }}>
                {d.day}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GoalRing({ goals }: { goals: Goal[] }): React.JSX.Element {
  const [idx, setIdx] = useState(0);
  const goal   = goals[idx];
  const r      = 50;
  const circ   = 2 * Math.PI * r;
  const pct    = goal ? Math.min(goal.currentAmount / goal.targetAmount, 1) : 0;
  const offset = circ * (1 - pct);

  if (goals.length === 0) {
    return (
      <div style={{ ...card.wrap, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 200 }}>
        <span style={{ fontSize: 28 }}>🎯</span>
        <div style={{ fontSize: 13, color: 'var(--ink-350)' }}>No goals set</div>
      </div>
    );
  }

  return (
    <div style={{ ...card.wrap, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div style={card.title}>Savings Goals</div>
        {goals.length > 1 && (
          <div style={{ display: 'flex', gap: 5 }}>
            {goals.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                style={{ width: 7, height: 7, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0,
                  background: i === idx ? '#ec4899' : 'var(--ink-150)' }}
              />
            ))}
          </div>
        )}
      </div>

      <svg width="130" height="130" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--ink-080)" strokeWidth="10" />
        <circle
          cx="60" cy="60" r={r} fill="none"
          stroke="url(#goalGrad)" strokeWidth="10"
          strokeDasharray={`${circ}`}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 60 60)"
          style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(0.4,0,0.2,1)' }}
        />
        <defs>
          <linearGradient id="goalGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ec4899" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>
        <text x="60" y="56" textAnchor="middle" fill="var(--text-primary)" fontSize="18" fontWeight="800" fontFamily="Inter, sans-serif">
          {Math.round(pct * 100)}%
        </text>
        <text x="60" y="70" textAnchor="middle" fill="var(--ink-350)" fontSize="8" fontFamily="Inter, sans-serif">
          GOAL
        </text>
      </svg>

      <div style={{ marginTop: 8, textAlign: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{goal?.name}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-350)', marginTop: 3 }}>
          €{goal?.currentAmount.toLocaleString()} of €{goal?.targetAmount.toLocaleString()}
        </div>
      </div>
    </div>
  );
}

// ─── Category pie — bunq 4-colour donut with perimeter icons (audit §3, ref 10)

interface CategorySlice { label: string; amount: number; icon: string }

/** bunq's categorical wheel: purple → orange → yellow → red, in that order. */
const PIE_HUES = ['var(--hue-purple)', 'var(--hue-orange)', 'var(--hue-yellow)', 'var(--hue-red)'] as const;

/** Donut segment as a single filled path (outer arc → inner arc → close). */
function donutPath(start: number, end: number, rOuter = 58, rInner = 36): string {
  const a0 = start * 2 * Math.PI - Math.PI / 2;
  const a1 = end   * 2 * Math.PI - Math.PI / 2;
  const x0 = 60 + rOuter * Math.cos(a0), y0 = 60 + rOuter * Math.sin(a0);
  const x1 = 60 + rOuter * Math.cos(a1), y1 = 60 + rOuter * Math.sin(a1);
  const x2 = 60 + rInner * Math.cos(a1), y2 = 60 + rInner * Math.sin(a1);
  const x3 = 60 + rInner * Math.cos(a0), y3 = 60 + rInner * Math.sin(a0);
  const large = end - start > 0.5 ? 1 : 0;
  return `M ${x0} ${y0} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1} `
       + `L ${x2} ${y2} A ${rInner} ${rInner} 0 ${large} 0 ${x3} ${y3} Z`;
}

function CategoryPie({ data }: { data: CategorySlice[] }): React.JSX.Element {
  const total = data.reduce((sum, d) => sum + d.amount, 0) || 1;

  let acc = 0;
  const slices = data.map((d, i) => {
    const start = acc;
    acc += d.amount / total;
    return { ...d, start, end: acc, color: PIE_HUES[i % PIE_HUES.length]!, index: i };
  });

  return (
    <div style={{ ...card.wrap, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div style={card.title}>Spending by Category</div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', color: 'var(--accent-cyan)' }}>THIS WEEK</div>
      </div>

      <div style={{ position: 'relative', width: 160, height: 160 }}>
        <svg width={160} height={160} viewBox="0 0 120 120" role="img"
             aria-label={`Spending by category, total ${Math.round(total)} euro`}>
          {slices.map((sl) => (
            <path
              key={sl.label}
              d={donutPath(sl.start, sl.end)}
              fill={sl.color}
              stroke="var(--bg-base)"
              strokeWidth={1.5}
            />
          ))}
          {/* Centre knob carries the running total (ref 10_pie_chart.png) */}
          <circle cx={60} cy={60} r={28} fill="var(--bg-elevated)" stroke="var(--ink-060)" strokeWidth={1} />
          <text x={60} y={58} textAnchor="middle" fill="var(--text-primary)"
                fontSize={11} fontWeight={800} fontFamily="'Montserrat', sans-serif">
            €{Math.round(total).toLocaleString('nl-NL')}
          </text>
          <text x={60} y={70} textAnchor="middle" fill="var(--ink-350)"
                fontSize={7} fontWeight={600} letterSpacing={0.8}>TOTAL</text>
        </svg>

        {/* Category icons float on the perimeter, aligned to their segment */}
        {slices.map((sl) => {
          const mid = (sl.start + sl.end) / 2;
          const a   = mid * 2 * Math.PI - Math.PI / 2;
          return (
            <div
              key={`${sl.label}-icon`}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 80 + 78 * Math.cos(a),
                top:  80 + 78 * Math.sin(a),
                transform: 'translate(-50%, -50%)',
                width: 28, height: 28, borderRadius: 9,
                background: sl.color,
                border: '1px solid var(--on-tile-stroke-lift)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
                boxShadow: `0 4px 12px color-mix(in srgb, ${sl.color} 33%, transparent)`,
                animation: 'float 3s ease-in-out infinite',
                animationDelay: `${sl.index * 0.2}s`,
              }}
            >
              {sl.icon}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', marginTop: 16 }}>
        {slices.map((sl) => (
          <div key={`${sl.label}-legend`} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--ink-650)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: sl.color, display: 'inline-block' }} />
            {sl.label}
            <span style={{ color: 'var(--ink-350)' }}>{Math.round((sl.amount / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ESG impact — bunq Green globe (audit §6) ────────────────────────────────

function GreenImpact({ trees }: { trees: number }): React.JSX.Element {
  return (
    <div style={{
      ...card.wrap,
      background: 'color-mix(in srgb, var(--esg-green) 6%, transparent)',
      border: '1px solid color-mix(in srgb, var(--esg-green) 15%, transparent)',
      borderLeft: '3px solid var(--esg-green)',
      padding: 16,
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <span style={{ fontSize: 18 }} aria-hidden="true">🌍</span>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--esg-green)' }}>
          You planted {trees} trees
        </div>
        <div style={{ fontSize: 10, color: 'var(--ink-450)', marginTop: 2 }}>
          ESG impact · bunq Green
        </div>
      </div>
      <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: 'var(--esg-green)' }}>
        +{trees}
      </span>
    </div>
  );
}

// ─── Feature 7: Security Posture ──────────────────────────────────────────────

function SecurityPosture({ fraudRiskScore }: { fraudRiskScore: number | null }): React.JSX.Element {
  // Security posture = inverse of fraud risk (high fraud risk = low security)
  const posture = fraudRiskScore !== null ? Math.round(100 - (fraudRiskScore * 0.6)) : 82;
  const label   = posture >= 80 ? 'EXCELLENT' : posture >= 60 ? 'GOOD' : 'AT RISK';
  const r       = 44;
  const circ    = 2 * Math.PI * r;
  const offset  = circ * (1 - posture / 100);

  return (
    <div style={{
      ...card.wrap,
      background: 'var(--panel-green-grad)',
      border: '1px solid rgba(34,197,94,0.15)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--hue-teal)' }}>
          Security Posture
        </div>
        <div style={{
          fontSize: 9, fontWeight: 700, padding: '3px 10px', borderRadius: 100,
          background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)',
          color: 'var(--hue-green)', letterSpacing: '0.08em',
        }}>
          ● ACTIVE
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        {/* Mini ring */}
        <svg width={100} height={100} style={{ flexShrink: 0 }}>
          <defs>
            <linearGradient id="securityRingGrad" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%"   stopColor="#ef4444" />
              <stop offset="33%"  stopColor="#eab308" />
              <stop offset="66%"  stopColor="#22c55e" />
              <stop offset="83%"  stopColor="#3b82f6" />
              <stop offset="100%" stopColor="#a855f7" />
            </linearGradient>
          </defs>
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--ink-070)" strokeWidth="9" />
          <circle cx="50" cy="50" r={r} fill="none"
            stroke="url(#securityRingGrad)" strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={`${circ}`}
            strokeDashoffset={offset}
            style={{ transform: 'rotate(-90deg)', transformOrigin: '50px 50px', transition: 'stroke-dashoffset 1s ease' }}
          />
          <text x="50" y="45" textAnchor="middle" fill="var(--text-primary)" fontSize="16" fontWeight="800" fontFamily="Inter,sans-serif">{posture}</text>
          <text x="50" y="58" textAnchor="middle" fill="var(--hue-green)" fontSize="6" fontWeight="700" fontFamily="Inter,sans-serif" letterSpacing="2">{label}</text>
        </svg>

        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Secure</div>
          <div style={{ fontSize: 11, color: 'var(--ink-450)', lineHeight: 1.5 }}>
            Your financial perimeter is protected. No critical threats detected.
          </div>
        </div>
      </div>

      {/* Single Write Gateway indicator */}
      <div style={{
        marginTop: 14, padding: '10px 14px', borderRadius: 12,
        background: 'var(--ink-030)', border: '1px solid var(--ink-070)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 9, flexShrink: 0,
          background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
        }}>🛡</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-strong)' }}>Single Write Gateway</div>
          <div style={{ fontSize: 10, color: 'var(--ink-350)', marginTop: 1 }}>All transfers authorised via BUNQSY</div>
        </div>
        {/* Toggle — always ON (constitutional rule) */}
        <div style={{
          width: 40, height: 22, borderRadius: 11, background: '#3b82f6',
          position: 'relative', flexShrink: 0,
          boxShadow: '0 0 12px rgba(59,130,246,0.4)',
        }}>
          <div style={{
            position: 'absolute', right: 3, top: 3,
            width: 16, height: 16, borderRadius: '50%', background: 'var(--text-on-accent)',
          }} />
        </div>
      </div>
    </div>
  );
}

// ─── Feature 3: Active Agents ─────────────────────────────────────────────────

function ActiveAgents({ votes, connected }: { votes: OracleVote[]; connected: boolean }): React.JSX.Element {
  return (
    <div style={card.wrap}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--hue-teal)' }}>
          Active Agents
        </div>
        <div style={{
          fontSize: 9, fontWeight: 700, padding: '3px 10px', borderRadius: 100,
          background: connected ? 'rgba(34,197,94,0.12)' : 'var(--ink-060)',
          border: `1px solid ${connected ? 'rgba(34,197,94,0.3)' : 'var(--ink-100)'}`,
          color: connected ? 'var(--hue-green)' : 'var(--ink-300)', letterSpacing: '0.08em',
        }}>
          {connected ? '● LIVE' : '○ OFFLINE'}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ALL_AGENTS.map((agent) => {
          const vote = votes.find(v => v.agentId === agent.id);
          // Confidence: inverse of risk for monitoring, direct for alerts
          const confidence = vote
            ? vote.shouldIntervene
              ? Math.round(vote.riskScore)
              : Math.round(100 - vote.riskScore * 0.4)
            : null;

          return (
            <div key={agent.id} style={{
              padding: '12px 14px', borderRadius: 14,
              background: 'var(--ink-025)',
              border: '1px solid var(--ink-050)',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{
                width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                background: `color-mix(in srgb, ${agent.color} 9%, transparent)`,
                border: `1px solid color-mix(in srgb, ${agent.color} 19%, transparent)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
              }}>
                {agent.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-strong)', marginBottom: 6, letterSpacing: '-0.01em' }}>
                  {agent.label}
                </div>
                <div style={{ height: 4, background: 'var(--ink-070)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 2,
                    width: confidence !== null ? `${confidence}%` : '0%',
                    background: agent.color,
                    transition: 'width 1s cubic-bezier(0.4,0,0.2,1)',
                    boxShadow: confidence !== null && confidence > 0 ? `0 0 8px color-mix(in srgb, ${agent.color} 38%, transparent)` : 'none',
                  }} />
                </div>
                {vote?.rationale && (
                  <div style={{ fontSize: 9, color: 'var(--ink-280)', marginTop: 4, lineHeight: 1.4, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                    {vote.rationale}
                  </div>
                )}
              </div>
              <div style={{
                fontSize: 14, fontWeight: 800, color: agent.color,
                letterSpacing: '-0.02em', flexShrink: 0, minWidth: 36, textAlign: 'right',
              }}>
                {confidence !== null ? `${confidence}%` : '—'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Feature 4: Guardian Feed ─────────────────────────────────────────────────

function statusPill(status: string): { label: string; color: string; bg: string } {
  if (status === 'EXECUTED')  return { label: 'AUTO',      color: 'var(--hue-green)', bg: 'rgba(34,197,94,0.12)'   };
  if (status === 'DISMISSED') return { label: 'DISMISSED', color: 'var(--ink-300)', bg: 'var(--ink-060)' };
  return { label: 'READY', color: 'var(--hue-amber)', bg: 'rgba(245,158,11,0.12)' };
}

function feedBorderColor(item: InterventionRow): string {
  if (item.status === 'EXECUTED')  return 'var(--hue-green)';
  if (item.status === 'DISMISSED') return 'var(--ink-120)';
  if (item.risk_score > 70) return '#ef4444';
  if (item.risk_score > 40) return 'var(--hue-amber)';
  return '#3b82f6';
}

function GuardianFeed({
  feed,
  onConfirmPlan,
  onDismissIntervention,
}: {
  feed: InterventionRow[];
  onConfirmPlan: (planId: string) => Promise<void>;
  onDismissIntervention: (id: string) => void;
}): React.JSX.Element {
  const [acting, setActing] = useState<string | null>(null);

  return (
    <div style={card.wrap}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={card.title}>Guardian Feed</div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', color: 'var(--hue-teal)' }}>
          LIVE UPDATES
        </div>
      </div>

      {feed.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--ink-250)', fontSize: 12 }}>
          No events yet — guardian is monitoring
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {feed.map((item) => {
            const meta = FEED_TYPE_META[item.type] ?? { icon: '📋', color: '#64748b' };
            const pill = statusPill(item.status);
            const bord = feedBorderColor(item);
            const isActive = item.status === 'SHOWN';

            return (
              <div key={item.id} style={{
                padding: '14px 16px',
                borderRadius: 16,
                background: isActive && item.risk_score > 60
                  ? 'rgba(239,68,68,0.04)'
                  : 'var(--ink-025)',
                border: '1px solid var(--ink-060)',
                borderLeft: `3px solid ${bord}`,
                position: 'relative',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  {/* Icon */}
                  <div style={{
                    width: 36, height: 36, borderRadius: 11, flexShrink: 0,
                    background: `color-mix(in srgb, ${meta.color} 9%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${meta.color} 19%, transparent)`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
                  }}>
                    {meta.icon}
                  </div>

                  {/* Body */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-strong)', letterSpacing: '-0.01em' }}>
                        {item.type.replace(/_/g, ' ')}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--ink-280)', flexShrink: 0 }}>
                        {timeAgo(item.created_at)}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ink-450)', lineHeight: 1.5, marginBottom: 8 }}>
                      {item.narration.length > 100 ? `${item.narration.slice(0, 100)}…` : item.narration}
                    </div>

                    {/* Status pill + action buttons */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{
                        fontSize: 9, fontWeight: 800, padding: '3px 9px', borderRadius: 100,
                        background: pill.bg, color: pill.color, letterSpacing: '0.10em',
                      }}>
                        {pill.label}
                      </div>

                      {isActive && item.execution_plan_id && (
                        <>
                          <button
                            disabled={acting === item.id}
                            onClick={async () => {
                              setActing(item.id);
                              await onConfirmPlan(item.execution_plan_id!);
                              setActing(null);
                            }}
                            style={{
                              padding: '4px 12px', borderRadius: 100, border: 'none', cursor: 'pointer',
                              background: '#ef4444', color: 'var(--text-on-accent)',
                              fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                              opacity: acting === item.id ? 0.6 : 1,
                            }}
                          >
                            Block
                          </button>
                          <button
                            disabled={acting === item.id}
                            onClick={() => { onDismissIntervention(item.id); }}
                            style={{
                              padding: '4px 12px', borderRadius: 100, border: '1px solid var(--ink-120)',
                              cursor: 'pointer', background: 'transparent', color: 'var(--ink-500)',
                              fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
                            }}
                          >
                            Approve
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Feature 6: Connected Accounts ───────────────────────────────────────────

function ConnectedAccounts({ summaries }: { summaries: AccountSummary[] }): React.JSX.Element | null {
  if (summaries.length === 0) return null;

  return (
    <div style={card.wrap}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={card.title}>Connected Banks</div>
        <div style={{ fontSize: 10, fontWeight: 600, color: '#3b82f6', cursor: 'pointer' }}>Add New</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {summaries.map((s) => {
          const col   = ACCOUNT_CLASS_COLOR[s.classification] ?? '#64748b';
          const initials = s.label.slice(0, 1).toUpperCase();
          const balEur = s.balanceCents / 100;
          const statusLabel = s.unusualSpendFlag ? 'RE-AUTH' : 'ACTIVE';
          const statusColor = s.unusualSpendFlag ? '#ef4444' : 'var(--hue-green)';
          const statusBg    = s.unusualSpendFlag ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)';

          return (
            <div key={s.account.id} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '14px 16px', borderRadius: 16,
              background: 'var(--ink-025)',
              border: '1px solid var(--ink-060)',
            }}>
              {/* Letter-avatar circle */}
              <div style={{
                width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
                background: col,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, fontWeight: 800, color: 'var(--text-primary)',
                fontFamily: "'Montserrat', sans-serif",
              }}>
                {initials}
              </div>

              {/* Name + masked number */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-strong)', letterSpacing: '-0.01em' }}>
                  {s.label}
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-320)', marginTop: 2 }}>
                  ···· {String(s.account.id).slice(-4).padStart(4, '0')}
                </div>
              </div>

              {/* Balance + status */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                  {s.currency}{balEur.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 100,
                  background: statusBg, color: statusColor, letterSpacing: '0.10em',
                }}>
                  {statusLabel}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Take Action card (feature 2: left-border accent, feature 8: status pills) ─

type ConfirmState = 'idle' | 'confirming' | 'loading' | 'done';

function ActionCard({ title, subtitle, icon, color, statusPillLabel, onApply }: {
  title: string; subtitle: string; icon: string; color: string;
  statusPillLabel?: string;
  onApply: () => Promise<void>;
}): React.JSX.Element {
  const [confirmState, setConfirmState] = useState<ConfirmState>('idle');

  async function handleApply(): Promise<void> {
    if (confirmState === 'confirming') {
      setConfirmState('loading');
      try {
        await onApply();
        setConfirmState('done');
        setTimeout(() => setConfirmState('idle'), 3000);
      } catch {
        setConfirmState('idle');
      }
    } else {
      setConfirmState('confirming');
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '14px 16px',
      background: 'var(--ink-025)',
      border: '1px solid var(--ink-060)',
      borderLeft: `3px solid ${color}`,   /* feature 2: colored left-border accent */
      borderRadius: 16,
      transition: 'border-color 0.2s',
    }}>
      {/* Icon */}
      <div style={{
        width: 42, height: 42, borderRadius: 13, flexShrink: 0,
        background: `color-mix(in srgb, ${color} 13%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 19,
      }}>
        {icon}
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-strong)', letterSpacing: '-0.01em' }}>{title}</div>
          {/* Feature 8: status pill */}
          {statusPillLabel && (
            <div style={{
              fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 100,
              background: statusPillLabel === 'READY'
                ? 'rgba(34,197,94,0.15)'
                : statusPillLabel === 'AUTO'
                ? 'var(--ink-070)'
                : 'rgba(59,130,246,0.12)',
              color: statusPillLabel === 'READY'
                ? 'var(--hue-green)'
                : statusPillLabel === 'AUTO'
                ? 'var(--ink-400)'
                : '#60a5fa',
              letterSpacing: '0.10em', flexShrink: 0,
            }}>
              {statusPillLabel}
            </div>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-380)', marginTop: 2, lineHeight: 1.4 }}>{subtitle}</div>
      </div>

      {/* CTA */}
      {confirmState === 'done' ? (
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--hue-emerald)', whiteSpace: 'nowrap' }}>Done ✓</div>
      ) : confirmState === 'confirming' ? (
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button
            onClick={() => { void handleApply(); }}
            style={{ ...applyBtn, background: color, color: 'var(--text-on-accent)', padding: '6px 12px' }}
          >
            Yes
          </button>
          <button
            onClick={() => setConfirmState('idle')}
            style={{ ...applyBtn, background: 'var(--ink-070)', color: 'var(--ink-500)', padding: '6px 12px' }}
          >
            No
          </button>
        </div>
      ) : (
        <button
          onClick={() => { void handleApply(); }}
          disabled={confirmState === 'loading'}
          style={{
            ...applyBtn, background: '#3b82f6', color: 'var(--text-on-accent)', flexShrink: 0,
            opacity: confirmState === 'loading' ? 0.6 : 1,
          }}
        >
          {confirmState === 'loading' ? '…' : 'Apply'}
        </button>
      )}
    </div>
  );
}

// ─── Upcoming Expenses ────────────────────────────────────────────────────────

const EXPENSE_ICON: Record<string, string> = {
  RENT: '🏢', SUBSCRIPTION: '🔄', IMPULSE_RISK: '⚡', GOAL_MILESTONE: '🎯',
};

function UpcomingExpenses({ forecastData }: { forecastData: ForecastPoint[] | null }): React.JSX.Element {
  if (!forecastData || forecastData.length === 0) {
    return (
      <div style={card.wrap}>
        <div style={{ ...card.title, marginBottom: 12 }}>Upcoming Expenses</div>
        <div style={{ fontSize: 12, color: 'var(--ink-280)', padding: '12px 0' }}>
          No forecast data yet — run a heartbeat tick first
        </div>
      </div>
    );
  }

  const items: Array<{ type: string; label: string; daysUntil: number; amount: number; isRecurring: boolean; isRent: boolean }> = [];
  for (let i = 0; i < forecastData.length && items.length < 5; i++) {
    const pt = forecastData[i];
    if (!pt) continue;
    for (const ev of pt.events) {
      if (ev.type === 'SALARY' || ev.type === 'GOAL_MILESTONE') continue;
      items.push({
        type:       ev.type,
        label:      ev.description || ev.type,
        daysUntil:  i + 1,
        amount:     ev.amount ?? 0,
        isRecurring: ev.type === 'SUBSCRIPTION' || ev.type === 'RENT',
        isRent:     ev.type === 'RENT',
      });
    }
  }

  if (items.length === 0) {
    return (
      <div style={card.wrap}>
        <div style={{ ...card.title, marginBottom: 12 }}>Upcoming Expenses</div>
        <div style={{ fontSize: 12, color: 'var(--ink-280)', padding: '12px 0' }}>
          No upcoming expenses detected in the next 30 days
        </div>
      </div>
    );
  }

  return (
    <div style={card.wrap}>
      <div style={{ ...card.title, marginBottom: 16 }}>Upcoming Expenses</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((item, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: '14px 16px', borderRadius: 16,
            background: item.isRent ? 'rgba(0,191,255,0.04)' : 'var(--ink-025)',
            border: '1px solid var(--ink-060)',
            borderLeft: item.isRent ? '3px solid var(--accent-cyan)' : '3px solid var(--ink-100)',
          }}>
            <div style={{
              width: 42, height: 42, borderRadius: 13, flexShrink: 0,
              background: item.isRent ? 'rgba(0,191,255,0.12)' : 'var(--ink-060)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            }}>
              {EXPENSE_ICON[item.type] ?? '📌'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-strong)', letterSpacing: '-0.01em' }}>
                {item.label}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-350)', marginTop: 2 }}>
                Due in {item.daysUntil} day{item.daysUntil !== 1 ? 's' : ''}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0 }}>
              {item.amount > 0 && (
                <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                  €{item.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              )}
              {item.isRecurring && (
                <div style={{
                  fontSize: 9, fontWeight: 800, letterSpacing: '0.10em', padding: '2px 8px',
                  borderRadius: 100, textTransform: 'uppercase',
                  background: item.isRent ? 'rgba(0,191,255,0.15)' : 'var(--ink-080)',
                  color: item.isRent ? 'var(--accent-cyan)' : 'var(--ink-450)',
                }}>
                  {item.isRent ? 'RECURRING' : 'AUTOPAY'}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── KPI Tiles ────────────────────────────────────────────────────────────────

function KpiTiles({ kpis }: { kpis: Kpis | null }): React.JSX.Element {
  const savingRate      = kpis?.savingRate      ?? 0;
  const savingRateDelta = kpis?.savingRateDelta ?? 0;
  const burnRateDaily   = kpis?.burnRateDaily   ?? 0;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
      <div style={{
        ...card.wrap,
        background: 'var(--panel-green-soft)',
        border: '1px solid rgba(34,197,94,0.14)',
        borderLeft: '3px solid var(--hue-green)',
      }}>
        <div style={{ fontSize: 22, lineHeight: 1 }}>📈</div>
        <div style={{ fontSize: 12, color: 'var(--ink-450)', marginTop: 10 }}>Saving Rate</div>
        <div style={{
          fontSize: 34, fontWeight: 800, color: 'var(--hue-green)',
          letterSpacing: '-0.04em', lineHeight: 1, marginTop: 4,
          fontFamily: "'Montserrat', sans-serif",
        }}>
          {savingRate}%
        </div>
        <div style={{
          fontSize: 11, marginTop: 6,
          color: savingRateDelta > 0 ? 'var(--hue-green)' : savingRateDelta < 0 ? '#EF4444' : 'var(--ink-300)',
        }}>
          {savingRateDelta > 0 ? `+${savingRateDelta}%` : savingRateDelta < 0 ? `${savingRateDelta}%` : 'No change'} from last month
        </div>
      </div>

      <div style={{
        ...card.wrap,
        background: 'var(--panel-red-soft)',
        border: '1px solid rgba(239,68,68,0.14)',
        borderLeft: '3px solid #ef4444',
      }}>
        <div style={{ fontSize: 22, lineHeight: 1 }}>🔥</div>
        <div style={{ fontSize: 12, color: 'var(--ink-450)', marginTop: 10 }}>Burn Rate</div>
        <div style={{
          fontSize: 34, fontWeight: 800, color: '#EF4444',
          letterSpacing: '-0.04em', lineHeight: 1, marginTop: 4,
          fontFamily: "'Montserrat', sans-serif",
        }}>
          €{Math.round(burnRateDaily)}
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-300)', marginTop: 6 }}>
          Daily avg. spending
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function InsightsScreen({ ws, dreamBriefing, accountSummaries, onConfirmPlan, onDismissIntervention }: InsightsProps): React.JSX.Element {
  const [data, setData]     = useState<InsightsData | null>(null);
  const [feed, setFeed]     = useState<InterventionRow[]>([]);
  const forecast = useForecast();

  const fetchInsights = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/insights');
      if (res.ok) setData(await res.json() as InsightsData);
    } catch { /* daemon offline — keep previous data */ }
  }, []);

  const fetchFeed = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/interventions');
      if (res.ok) setFeed(await res.json() as InterventionRow[]);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    void fetchInsights();
    void fetchFeed();
    const t1 = setInterval(() => { void fetchInsights(); }, 30_000);
    const t2 = setInterval(() => { void fetchFeed(); }, 15_000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [fetchInsights, fetchFeed]);

  const activeDream = data?.dreamSession ?? null;

  // AI insights from oracle votes
  const insights = ws.votes
    .filter(v => v.shouldIntervene || v.riskScore >= 55)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 4);

  // Fraud Shadow agent vote → security posture
  const fraudVote = ws.votes.find(v => v.agentId === 'fraud-shadow');

  // Derive Take Action items
  type ActionItem = { key: string; title: string; subtitle: string; icon: string; color: string; statusPill?: string; onApply: () => Promise<void> };
  const actions: ActionItem[] = [];

  if (ws.intervention) {
    const meta = ACTION_META[ws.intervention.type] ?? { title: ws.intervention.type, icon: '💡', color: 'var(--accent-cyan)' };
    actions.push({
      key:        ws.intervention.id,
      title:      meta.title,
      subtitle:   ws.intervention.narration.slice(0, 80) + (ws.intervention.narration.length > 80 ? '…' : ''),
      icon:       meta.icon,
      color:      meta.color,
      statusPill: 'READY',
      onApply:  async () => {
        if (ws.intervention?.executionPlanId) {
          await onConfirmPlan(ws.intervention.executionPlanId);
        } else {
          onDismissIntervention(ws.intervention!.id);
        }
      },
    });
  }

  const jarVote = ws.votes.find(v => v.agentId === 'jar-optimizer' && v.riskScore > 40);
  if (jarVote && !actions.find(a => a.key === 'jar')) {
    actions.push({
      key: 'jar', title: 'Auto-Round Up', icon: '🐷', color: 'var(--hue-emerald)',
      statusPill: 'READY',
      subtitle: jarVote.rationale?.slice(0, 80) ?? 'Optimise your savings jars this week',
      onApply: async () => { await fetch('/api/dismiss/jar-suggestion', { method: 'POST' }).catch(() => {}); },
    });
  }

  const dreamSuggestions = dreamBriefing?.suggestions ?? activeDream?.suggestions ?? [];
  dreamSuggestions.slice(0, 3 - actions.length).forEach((s, i) => {
    actions.push({
      key: `dream-${i}`, title: 'Dream Suggestion', icon: '✨', color: 'var(--accent-cyan)',
      statusPill: 'AUTO',
      subtitle: s.slice(0, 80) + (s.length > 80 ? '…' : ''),
      onApply: async () => { await Promise.resolve(); },
    });
  });

  if (actions.length === 0) {
    actions.push(
      { key: 'd1', title: 'Auto-Round Up', icon: '🐷', color: 'var(--hue-emerald)',
        statusPill: 'READY',
        subtitle: 'Save a little more each week automatically', onApply: async () => { await Promise.resolve(); } },
      { key: 'd2', title: 'Invest Spare Cash', icon: '🏦', color: 'var(--hue-amber)',
        statusPill: 'READY',
        subtitle: 'Expected 4.2% APY on idle balance', onApply: async () => { await Promise.resolve(); } },
      { key: 'd3', title: 'Review Subscriptions', icon: '📺', color: '#8B5CF6',
        statusPill: 'AUTO',
        subtitle: 'Consolidate streaming platforms & save', onApply: async () => { await Promise.resolve(); } },
    );
  }

  const weeklySpending = data?.weeklySpending ?? [
    { day: 'Mon', amount: 0 }, { day: 'Tue', amount: 0 }, { day: 'Wed', amount: 0 },
    { day: 'Thu', amount: 0 }, { day: 'Fri', amount: 0 }, { day: 'Sat', amount: 0 }, { day: 'Sun', amount: 0 },
  ];
  const goals = data?.goals ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* Dream Mode Hero */}
      <DreamHeroCard dream={activeDream} dreamBriefing={dreamBriefing} />

      {/* Spending + Goal row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 18, alignItems: 'start' }}>
        <SpendingBarsChart data={weeklySpending} />
        <GoalRing goals={goals} />
      </div>

      {/* KPI Tiles */}
      <KpiTiles kpis={data?.kpis ?? null} />

      {/* Category pie + ESG impact (audit §3 / §6).
          The daemon has no category breakdown endpoint yet, so this mirrors the
          dashboard's demo categories — swap `PIE_DEMO_DATA` for live data the
          moment /api/insights exposes it. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 24, alignItems: 'start' }}>
        <CategoryPie data={PIE_DEMO_DATA} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <GreenImpact trees={12} />
        </div>
      </div>

      {/* Security Posture + Connected Accounts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' }}>
        <SecurityPosture fraudRiskScore={fraudVote?.riskScore ?? null} />
        <ConnectedAccounts summaries={accountSummaries} />
      </div>

      {/* Active Agents */}
      <ActiveAgents votes={ws.votes} connected={ws.connected} />

      {/* Guardian Feed */}
      <GuardianFeed
        feed={feed}
        onConfirmPlan={onConfirmPlan}
        onDismissIntervention={(id) => {
          setFeed(prev => prev.map(f => f.id === id ? { ...f, status: 'DISMISSED' } : f));
          onDismissIntervention(id);
        }}
      />

      {/* AI Insights */}
      <div style={card.wrap}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 18 }}>💡</span>
          <div style={card.title}>AI Insights</div>
          {ws.verdict && (
            <div style={{
              marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '3px 10px',
              borderRadius: 100, letterSpacing: '0.08em',
              background: ws.verdict.aggregateRiskScore >= 70 ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.12)',
              color: ws.verdict.aggregateRiskScore >= 70 ? '#EF4444' : 'var(--hue-amber)',
            }}>
              Risk {Math.round(ws.verdict.aggregateRiskScore)}
            </div>
          )}
        </div>

        {insights.length === 0 ? (
          <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--ink-280)', fontSize: 12 }}>
            {ws.connected
              ? 'Oracle is healthy — no alerts at this time'
              : 'Waiting for oracle data…'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {insights.map(vote => {
              const meta = AGENT_META[vote.agentId] ?? { title: vote.agentId, icon: '🔎', color: 'var(--hue-slate)', bg: 'rgba(148,163,184,0.08)' };
              return (
                <div key={vote.agentId} style={{
                  padding: '14px 16px', borderRadius: 14,
                  background: meta.bg,
                  border: `1px solid color-mix(in srgb, ${meta.color} 16%, transparent)`,
                  borderLeft: `3px solid ${meta.color}`,
                  display: 'flex', gap: 12, alignItems: 'flex-start',
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 11, flexShrink: 0,
                    background: `color-mix(in srgb, ${meta.color} 13%, transparent)`, border: `1px solid color-mix(in srgb, ${meta.color} 20%, transparent)`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 16,
                  }}>
                    {meta.icon}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-strong)', marginBottom: 4 }}>{meta.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-500)', lineHeight: 1.5 }}>
                      {vote.rationale ?? `Risk score: ${Math.round(vote.riskScore)}. ${vote.agentId.replace(/-/g, ' ')}.`}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 10, fontWeight: 700, color: meta.color }}>
                      Risk {Math.round(vote.riskScore)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Upcoming Expenses */}
      <UpcomingExpenses forecastData={forecast.data} />

      {/* Take Action */}
      <div style={card.wrap}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={card.title}>Take Action</div>
          <button
            onClick={() => { void fetch('/api/interventions').then(r => r.json()); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#3b82f6', fontWeight: 600, padding: 0 }}
          >
            View All →
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {actions.map(a => (
            <ActionCard
              key={a.key}
              title={a.title}
              subtitle={a.subtitle}
              icon={a.icon}
              color={a.color}
              statusPillLabel={a.statusPill}
              onApply={a.onApply}
            />
          ))}
        </div>
      </div>

    </div>
  );
}

// ─── Style tokens ─────────────────────────────────────────────────────────────

const card = {
  wrap: {
    background:   'var(--ink-042)',
    border:       '1px solid var(--ink-080)',
    borderRadius: 22,
    padding:      20,
  } as React.CSSProperties,
  title: {
    fontSize: 15, fontWeight: 700, color: 'var(--text-strong)', letterSpacing: '-0.01em',
  } as React.CSSProperties,
  subtitle: {
    fontSize: 11, color: 'var(--ink-350)', marginTop: 2,
  } as React.CSSProperties,
};

const applyBtn: React.CSSProperties = {
  padding: '7px 16px', borderRadius: 100, border: 'none',
  fontSize: 12, fontWeight: 700, cursor: 'pointer',
  fontFamily: "'Inter', sans-serif", letterSpacing: '0.02em',
  transition: 'opacity 0.15s',
};
