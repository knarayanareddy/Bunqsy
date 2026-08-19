import React, { useState, useEffect, useRef } from 'react';
import type { AccountSummary } from '@bunqsy/shared';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useLocalSim } from './hooks/useLocalSim.js';
import { BUNQSYScore } from './components/BunqsyScore.js';
import { OracleVotingPanel } from './components/OracleVotingPanel.js';
import { InterventionCard } from './components/InterventionCard.js';
import { VoiceOrb, speakText } from './components/VoiceOrb.js';
import { ReceiptScanner } from './components/ReceiptScanner.js';
import { DreamTrigger, DreamBriefingModal, type DreamBriefingType } from './components/DreamBriefing.js';
import { ForecastChart } from './components/ForecastChart.js';
import { FraudBlock } from './components/FraudBlock.js';
import { DNACard } from './components/DNACard.js';
import { RecentTransactions } from './components/RecentTransactions.js';
import { ReviewQueue } from './components/bookkeeping/ReviewQueue.js';
import { ProfitAndLoss } from './components/bookkeeping/ProfitAndLoss.js';
import { VatTracker } from './components/bookkeeping/VatTracker.js';
import { ExportModal } from './components/bookkeeping/ExportModal.js';
import { BookkeepingStatus } from './components/bookkeeping/BookkeepingStatus.js';
import { InsightsScreen } from './components/InsightsScreen.js';
import { CardsPanel } from './components/CardsPanel.js';

// ── Superscript-decimal currency (matches authentic bunq visual language) ─────
function BunqBalance({
  amount,
  currency = '€',
  intSize = 22,
}: {
  amount: number;
  currency?: string;
  intSize?: number;
}): React.JSX.Element {
  const [intStr, decStr] = Math.abs(amount).toFixed(2).split('.');
  const formatted = parseInt(intStr, 10).toLocaleString('en-US');
  const decSize = Math.round(intSize * 0.53);
  const topOffset = Math.round(intSize * 0.1);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-start', lineHeight: 1 }}>
      <span style={{ fontSize: `${intSize}px`, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em', lineHeight: 1 }}>
        {currency}&nbsp;{formatted}.
      </span>
      <span style={{ fontSize: `${decSize}px`, fontWeight: 700, color: '#fff', lineHeight: 1, marginTop: `${topOffset}px` }}>
        {decStr}
      </span>
    </span>
  );
}

// ── Account tiles: live data when daemon is connected, static fallback for offline/demo ──
const ACCOUNT_TILES_FALLBACK = [
  { icon: '🏠', tileClass: 'bunq-tile-gold',   label: 'Bills',     amount: 1227.24, currency: '€' },
  { icon: '🥦', tileClass: 'bunq-tile-sky',    label: 'Groceries', amount: 250.58,  currency: '€' },
  { icon: '💰', tileClass: 'bunq-tile-green',  label: 'Savings',   amount: 2346.45, currency: '€' },
] as const;

const GOAL_TILES_FALLBACK = [
  { icon: '✈️', tileClass: 'bunq-tile-travel', label: 'Amsterdam Trip', amount: 680,  goal: 1000, currency: '€' },
  { icon: '🐷', tileClass: 'bunq-tile-pink',   label: 'Emergency Fund', amount: 3200, goal: undefined, currency: '€' },
] as const;

function tileMetaForClassification(c: string): { icon: string; tileClass: string } {
  switch (c) {
    case 'primary': return { icon: '🏦', tileClass: 'bunq-tile-gold' };
    case 'savings': return { icon: '🐷', tileClass: 'bunq-tile-green' };
    case 'joint':   return { icon: '👫', tileClass: 'bunq-tile-sky' };
    default:        return { icon: '💳', tileClass: 'bunq-tile-gold' };
  }
}


const SPEND_CATS: Array<{ icon: string; bg: string; label: string; txCount: number; amount: number; pct: number }> = [
  { icon: '🏠', bg: '#7A5200', label: 'Rent & Bills',  txCount: 2, amount: 950.00,  pct: 70 },
  { icon: '🍽️', bg: '#6A1A8A', label: 'Dining Out',    txCount: 5, amount: 284.50,  pct: 56 },
  { icon: '🛒', bg: '#1A4480', label: 'Groceries',     txCount: 4, amount: 178.24,  pct: 42 },
  { icon: '🔄', bg: '#1A4D2E', label: 'Subscriptions', txCount: 3, amount: 95.97,   pct: 28 },
];

// ─────────────────────────────────────────────────────────────────────────────

export function App(): React.JSX.Element {
  const ws = useWebSocket();
  const sim = useLocalSim();
  const lastSpokenInterventionId = useRef<string | null>(null);
  const [dreamModalOpen, setDreamModalOpen] = useState(false);
  const [dreamBriefing, setDreamBriefing] = useState<DreamBriefingType | null>(null);
  const [dreamRunning, setDreamRunning] = useState(false);
  const [accountSummaries, setAccountSummaries] = useState<AccountSummary[]>([]);
  const [weeklySpending, setWeeklySpending] = useState<Array<{ day: string; amount: number }> | null>(null);
  const [liveGoals, setLiveGoals] = useState<Array<{ name: string; targetAmount: number; currentAmount: number }> | null>(null);
  const [pendingReview, setPendingReview] = useState<number>(0);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    try { return localStorage.getItem('bunqsy_onboarding_dismissed') !== 'true'; } catch { return true; }
  });
  const [showDelta, setShowDelta] = useState(false);
  const [dismissedInterventionId, setDismissedInterventionId] = useState<string | null>(null);
  const [txRefreshKey, setTxRefreshKey] = useState(0);
  const [fundingState, setFundingState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [activeTab, setActiveTab]       = useState<'dashboard' | 'insights' | 'cards' | 'bookkeeping'>('dashboard');
  const [exportModalOpen, setExportModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchAccounts(): Promise<void> {
      try {
        const res = await fetch('/api/accounts');
        if (!res.ok) return;
        const data = await res.json() as AccountSummary[];
        if (!cancelled) setAccountSummaries(data);
      } catch { /* daemon not running — silent */ }
    }
    void fetchAccounts();
    const timer = setInterval(() => { void fetchAccounts(); }, 30_000);
    return (): void => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function fetchInsightsLite(): Promise<void> {
      try {
        const [insRes, statusRes] = await Promise.all([
          fetch('/api/insights').then(r => r.ok ? r.json() : null).catch(() => null),
          fetch('/api/bookkeeping/status').then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (cancelled) return;
        if (insRes?.weeklySpending) setWeeklySpending(insRes.weeklySpending as Array<{ day: string; amount: number }>);
        if (insRes?.goals) setLiveGoals(insRes.goals as Array<{ name: string; targetAmount: number; currentAmount: number }>);
        if (statusRes?.pendingReview !== undefined) setPendingReview(statusRes.pendingReview as number);
      } catch { /* silent */ }
    }
    void fetchInsightsLite();
    const t = setInterval(() => { void fetchInsightsLite(); }, 30_000);
    return (): void => { cancelled = true; clearInterval(t); };
  }, [txRefreshKey]);

  // Auto-TTS when a new intervention arrives; also clear any prior dismissed state
  useEffect(() => {
    if (ws.intervention && ws.intervention.id !== lastSpokenInterventionId.current) {
      lastSpokenInterventionId.current = ws.intervention.id;
      setDismissedInterventionId(null);
      void speakText(ws.intervention.narration);
    }
  }, [ws.intervention]);

  // Show score delta toast for 6 seconds when a new explanation arrives
  useEffect(() => {
    if (ws.scoreDelta) {
      setShowDelta(true);
      const t = setTimeout(() => setShowDelta(false), 6000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [ws.scoreDelta]);

  // Open dream modal when the real WS dream_complete event arrives (voice or scheduled)
  useEffect(() => {
    if (!ws.dreamBriefing) return;
    setDreamBriefing({
      sessionId:   ws.dreamBriefing.sessionId,
      briefingText: ws.dreamBriefing.briefingText,
      dnaCard:     ws.dreamBriefing.dnaCard,
      suggestions: ws.dreamBriefing.suggestions,
      completedAt: new Date().toISOString(),
    });
    setDreamRunning(false);
    setDreamModalOpen(true);
    void speakText('Your dream mode analysis is complete. Opening your financial briefing now.');
  }, [ws.dreamBriefing]);

  async function handleDemoReset(): Promise<void> {
    await fetch('/api/demo/reset', { method: 'POST' });
    window.location.reload();
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-base)',
      color: 'var(--text-primary)',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      position: 'relative',
      overflowX: 'hidden',
    }}>

      {/* Ambient gradient mesh */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
        background: `
          radial-gradient(ellipse 60% 40% at 10% 8%,  rgba(0,191,255,0.05) 0%, transparent 60%),
          radial-gradient(ellipse 50% 35% at 90% 90%, rgba(0,200,150,0.04) 0%, transparent 60%),
          radial-gradient(ellipse 40% 30% at 50% 50%, rgba(55,126,247,0.03) 0%, transparent 60%)
        `,
      }} />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: 'rgba(9,9,9,0.92)',
        backdropFilter: 'blur(28px)', WebkitBackdropFilter: 'blur(28px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{
          maxWidth: '1400px', margin: '0 auto', padding: '0 28px',
          height: '72px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div className="bunq-rainbow" style={{ width: '40px', height: '40px', borderRadius: '12px' }} />
            <div>
              <div style={{
                fontSize: '17px', fontWeight: 800, letterSpacing: '-0.03em',
                fontFamily: "'Montserrat', sans-serif",
                background: 'linear-gradient(135deg, #00bfff, #00ff95)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              }}>
                BUNQSY
              </div>
              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.26)', fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', lineHeight: 1, marginTop: '2px' }}>
                Financial Guardian
              </div>
            </div>
            <div className="bunq-badge">bunq Hackathon 7.0</div>
          </div>

          {/* Nav actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '6px 12px', borderRadius: '100px',
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
              fontSize: '11px', color: 'rgba(255,255,255,0.32)',
            }}>
              <div style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: ws.connected ? '#00ff95' : '#ff3b30',
                boxShadow: ws.connected ? '0 0 7px rgba(0,255,149,0.9)' : '0 0 7px rgba(255,59,48,0.9)',
                animation: ws.connected ? 'pulse 2s infinite' : 'none',
              }} />
              <span>{ws.connected ? 'Live · 30s' : 'Reconnecting'}</span>
            </div>

            <button
              onClick={() => { void sim.runSalaryOracle(); }}
              disabled={sim.running}
              style={{
                background: sim.running ? 'transparent' : 'rgba(0,255,149,0.08)',
                border: `1px solid ${sim.running ? 'rgba(255,255,255,0.07)' : 'rgba(0,255,149,0.28)'}`,
                borderRadius: '100px', padding: '7px 16px',
                color: sim.running ? 'rgba(255,255,255,0.18)' : '#00ff95',
                fontSize: '12px', fontWeight: 600, cursor: sim.running ? 'not-allowed' : 'pointer',
                fontFamily: "'Montserrat', sans-serif", letterSpacing: '0.02em',
              }}
            >
              💰 Salary In
            </button>

            <DreamTrigger
              running={dreamRunning}
              onTrigger={async () => {
                setDreamRunning(true);
                await fetch('/api/demo/reset', { method: 'POST' });
                setTimeout(() => {
                  setDreamBriefing({
                    sessionId: '1',
                    briefingText: "Last night I analysed your last 7 days of spending. You're tracking well against your Amsterdam goal — you saved €140 more than last week.",
                    dnaCard: 'Disciplined saver, impulsive weekends',
                    suggestions: [
                      'Cap weekend dining at €80 this week',
                      'Move €200 to Amsterdam trip goal now',
                      'Cancel duplicate streaming subscriptions',
                    ],
                    completedAt: new Date().toISOString(),
                  });
                  setDreamRunning(false);
                  setDreamModalOpen(true);
                }, 3000);
              }}
            />

            <div style={{
              width: '34px', height: '34px', borderRadius: '50%',
              background: 'linear-gradient(135deg, #00bfff, #00ff95)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '13px', fontWeight: 800, color: '#000', cursor: 'pointer',
              fontFamily: "'Montserrat', sans-serif",
            }}>K</div>
          </div>
        </div>
      </header>

      {/* ── Tab bar ────────────────────────────────────────────────────────── */}
      <div style={{
        background: 'rgba(9,9,9,0.80)', backdropFilter: 'blur(16px)',
        borderBottom: '1px solid rgba(255,255,255,0.05)', zIndex: 99, position: 'sticky', top: '72px',
      }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '0 28px', display: 'flex', gap: '0' }}>
          {([
            ['dashboard',   '📊 Dashboard'],
            ['insights',    '💡 Insights'],
            ['cards',       '💳 Cards'],
            ['bookkeeping', '📒 Tax & Books'],
          ] as const).map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                background: 'none', border: 'none',
                borderBottom: activeTab === tab ? '2px solid #00bfff' : '2px solid transparent',
                padding: '14px 20px', cursor: 'pointer', fontFamily: "'Montserrat', sans-serif",
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: activeTab === tab ? '#00bfff' : 'rgba(255,255,255,0.35)',
                transition: 'all 0.2s', marginBottom: '-1px',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main layout ────────────────────────────────────────────────────── */}
      <main style={{ maxWidth: '1400px', margin: '0 auto', padding: '28px 24px', position: 'relative', zIndex: 1 }}>

      {/* ── Insights Tab ────────────────────────────────────────────────────── */}
      {activeTab === 'insights' && (
        <InsightsScreen
          ws={ws}
          dreamBriefing={dreamBriefing}
          accountSummaries={accountSummaries}
          onConfirmPlan={async (planId) => {
            await fetch(`/api/confirm/${planId}`, { method: 'POST' });
          }}
          onDismissIntervention={(id) => {
            void fetch(`/api/dismiss/${id}`, { method: 'POST' });
            setDismissedInterventionId(id);
          }}
        />
      )}

      {/* ── Cards Tab ───────────────────────────────────────────────────────── */}
      {activeTab === 'cards' && <CardsPanel />}

      {/* ── Bookkeeping Tab ─────────────────────────────────────────────────── */}
      {activeTab === 'bookkeeping' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <BookkeepingStatus onExportClick={() => setExportModalOpen(true)} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px', alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              <ProfitAndLoss />
              <VatTracker />
            </div>
            <ReviewQueue />
          </div>
          {exportModalOpen && <ExportModal onClose={() => setExportModalOpen(false)} />}
        </div>
      )}

      {activeTab === 'dashboard' && (<>

        {/* Score delta explainer toast */}
        {showDelta && ws.scoreDelta && (
          <div style={{
            marginBottom: '12px',
            padding: '10px 16px',
            borderRadius: '14px',
            background: ws.scoreDelta.delta >= 0
              ? 'rgba(0,255,149,0.08)'
              : 'rgba(239,68,68,0.08)',
            border: `1px solid ${ws.scoreDelta.delta >= 0 ? 'rgba(0,255,149,0.2)' : 'rgba(239,68,68,0.2)'}`,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            animation: 'slideUp 0.3s ease',
          }}>
            <span style={{
              fontSize: '1rem',
              fontWeight: 800,
              color: ws.scoreDelta.delta >= 0 ? '#00ff95' : '#ef4444',
              flexShrink: 0,
            }}>
              {ws.scoreDelta.delta >= 0 ? `+${ws.scoreDelta.delta}` : ws.scoreDelta.delta}
            </span>
            <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.7)', lineHeight: 1.4 }}>
              {ws.scoreDelta.reason}
            </span>
            <button
              onClick={() => setShowDelta(false)}
              style={{
                marginLeft: 'auto', background: 'none', border: 'none',
                color: 'rgba(255,255,255,0.25)', cursor: 'pointer', fontSize: '0.7rem', flexShrink: 0,
              }}
            >✕</button>
          </div>
        )}

        {/* Top-of-page intervention alerts */}
        {sim.salaryIntervention && (
          <div style={{ marginBottom: '18px', animation: 'slideUp 0.4s ease' }}>
            <InterventionCard
              intervention={{
                title: sim.salaryIntervention.title,
                narration: sim.salaryIntervention.narration,
                severity: 'LOW',
                actionLabel: sim.salaryIntervention.actionLabel,
                dismissLabel: 'Maybe later',
              }}
              onConfirm={() => { sim.resetOracle(); }}
              onDismiss={() => { sim.setSalaryIntervention(null); }}
            />
          </div>
        )}
        {ws.intervention &&
          ws.intervention.type !== 'FRAUD' &&
          ws.intervention.type !== 'FREEZE_CARD' &&
          ws.intervention.id !== dismissedInterventionId &&
          !sim.salaryIntervention && (
          <div style={{ marginBottom: '18px', animation: 'slideUp 0.4s ease' }}>
            <InterventionCard
              intervention={ws.intervention}
              onConfirm={async () => {
                const { id, executionPlanId } = ws.intervention!;
                if (executionPlanId) {
                  await fetch(`/api/confirm/${executionPlanId}`, { method: 'POST' });
                } else {
                  await fetch(`/api/dismiss/${id}`, { method: 'POST' });
                }
                setDismissedInterventionId(id);
              }}
              onDismiss={() => {
                const id = ws.intervention!.id;
                void fetch(`/api/dismiss/${id}`, { method: 'POST' });
                setDismissedInterventionId(id);
              }}
            />
          </div>
        )}

        {/* Bookkeeping banner — surfaces hidden value (Lina) */}
        {pendingReview > 0 && (
          <div
            role="status"
            aria-live="polite"
            style={{
              marginBottom: '14px',
              padding: '12px 16px',
              borderRadius: '14px',
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.2)',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              animation: 'slideUp 0.3s ease',
            }}
          >
            <span style={{ fontSize: '18px' }}>📒</span>
            <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.85)', fontWeight: 500 }}>
              Books need attention — <strong style={{ color: '#f59e0b' }}>{pendingReview} item{pendingReview!==1?'s':''} to review</strong>
            </span>
            <button
              onClick={() => setActiveTab('bookkeeping')}
              style={{
                marginLeft: 'auto',
                background: '#f59e0b',
                border: 'none',
                borderRadius: '100px',
                padding: '6px 14px',
                color: '#000',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: "'Montserrat', sans-serif",
              }}
            >
              Review now →
            </button>
            <button
              onClick={() => setPendingReview(0)}
              aria-label="Dismiss"
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '14px' }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Onboarding — first-run cold-start nudge (Lina) */}
        {showOnboarding && accountSummaries.length === 0 && !ws.score && (
          <div
            role="dialog"
            aria-label="Welcome to BUNQSY"
            style={{
              marginBottom: '18px',
              padding: '20px 24px',
              borderRadius: '18px',
              background: 'linear-gradient(135deg, rgba(0,191,255,0.10) 0%, rgba(0,255,149,0.08) 100%)',
              border: '1px solid rgba(0,191,255,0.18)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              animation: 'slideUp 0.4s ease',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: '#fff', fontFamily: "'Montserrat', sans-serif" }}>
                👋 Welcome to BUNQSY — your financial guardian is waking up
              </div>
              <button
                onClick={() => {
                  setShowOnboarding(false);
                  try { localStorage.setItem('bunqsy_onboarding_dismissed', 'true'); } catch {}
                }}
                aria-label="Dismiss onboarding"
                style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)', cursor: 'pointer', fontSize: '16px' }}
              >
                ✕
              </button>
            </div>
            <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.65)', lineHeight: 1.5 }}>
              Connect your bunq account and your Health Score, oracle and Dream Mode will come alive. New here? Try the sandbox:
              <strong style={{ color: '#00ff95' }}> Fund Sandbox (€500)</strong> or <strong style={{ color: '#00bfff' }}>Simulate Fraud</strong> to see the guardian in action.
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                onClick={async () => {
                  setFundingState('loading');
                  try {
                    const r = await fetch('/api/demo/fund-sandbox', { method: 'POST' });
                    if (!r.ok) throw new Error();
                    setFundingState('done'); setTxRefreshKey(k => k+1);
                    setTimeout(() => setFundingState('idle'), 6000);
                  } catch { setFundingState('error'); setTimeout(() => setFundingState('idle'), 4000); }
                }}
                style={{ background: 'rgba(0,255,149,0.15)', border: '1px solid rgba(0,255,149,0.3)', borderRadius: '100px', padding: '8px 16px', color: '#00ff95', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
              >
                💶 Fund Sandbox
              </button>
              <button
                onClick={() => { void sim.runFraudOracle(); }}
                style={{ background: 'rgba(255,21,0,0.10)', border: '1px solid rgba(255,21,0,0.25)', borderRadius: '100px', padding: '8px 16px', color: '#ff6a6a', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
              >
                ⚡ Simulate Fraud
              </button>
              <button
                onClick={() => {
                  setShowOnboarding(false);
                  try { localStorage.setItem('bunqsy_onboarding_dismissed', 'true'); } catch {}
                }}
                style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '100px', padding: '8px 16px', color: 'rgba(255,255,255,0.55)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
              >
                Got it
              </button>
            </div>
          </div>
        )}

        {/* ── Voice Command — top center ───────────────────────────────── */}
        <div className="glass" style={{ marginBottom: '14px', padding: '16px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', maxWidth: '560px', margin: '0 auto 14px' }}>
          <span className="section-label">Voice Command</span>
          <VoiceOrb
            activeIntervention={ws.intervention ? {
              id: ws.intervention.id,
              planId: ws.intervention.executionPlanId,
            } : null}
            onActionTriggered={(action) => {
              if (action === 'trigger_dream') setDreamRunning(true);
            }}
          />
        </div>

        {/* 3-column grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr 340px', gap: '18px', alignItems: 'start' }}>

          {/* ── LEFT COLUMN ─────────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

            <BUNQSYScore score={ws.score} />

            {/* ── Account Tiles ── live when daemon connected, fallback when offline */}
            <div style={{
              background: 'rgba(255,255,255,0.042)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '22px',
              padding: '0 20px',
              overflow: 'hidden',
            }}>
              <div className="section-label" style={{ padding: '16px 0 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Accounts</span>
                {accountSummaries.length > 0 && (
                  <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '100px', background: 'rgba(0,255,149,0.12)', color: '#00ff95', letterSpacing: '0.08em' }}>LIVE</span>
                )}
              </div>

              {(accountSummaries.length > 0 ? accountSummaries.slice(0, 3) : []).length > 0
                ? accountSummaries.slice(0, 3).map((s, i, arr) => {
                    const meta = tileMetaForClassification(s.classification);
                    const liveAmt = s.balanceCents / 100;
                    return (
                      <div key={String(s.account.id)}>
                        <div className="bunq-account-row">
                          <div className={`bunq-tile ${meta.tileClass}`} style={{ width: '54px', height: '54px', fontSize: '26px' }}>
                            {meta.icon}
                          </div>
                          <div style={{ flex: 1, fontSize: '16px', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {s.label}
                          </div>
                          <BunqBalance amount={liveAmt} currency={s.currency} intSize={19} />
                        </div>
                        {i < arr.length - 1 && <div className="bunq-divider" />}
                      </div>
                    );
                  })
                : ACCOUNT_TILES_FALLBACK.map((tile, i) => (
                    <div key={tile.label}>
                      <div className="bunq-account-row">
                        <div className={`bunq-tile ${tile.tileClass}`} style={{ width: '54px', height: '54px', fontSize: '26px' }}>
                          {tile.icon}
                        </div>
                        <div style={{ flex: 1, fontSize: '18px', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>
                          {tile.label}
                        </div>
                        <BunqBalance amount={tile.amount} currency={tile.currency} intSize={19} />
                      </div>
                      {i < ACCOUNT_TILES_FALLBACK.length - 1 && <div className="bunq-divider" />}
                    </div>
                  ))}

              {/* Goal tiles with progress bar — live when daemon has goals, fallback otherwise */}
              <div style={{ height: '1px', background: 'rgba(255,255,255,0.07)', margin: '0' }} />

              {(liveGoals && liveGoals.length > 0 ? liveGoals.slice(0, 3).map((g, idx) => {
                const meta = idx === 0 ? { icon: '✈️', tileClass: 'bunq-tile-travel' as const } : idx === 1 ? { icon: '🐷', tileClass: 'bunq-tile-pink' as const } : { icon: '🎯', tileClass: 'bunq-tile-gold' as const };
                const pct = g.targetAmount > 0 ? Math.round((g.currentAmount / g.targetAmount) * 100) : 0;
                return { label: g.name, icon: meta.icon, tileClass: meta.tileClass, amount: g.currentAmount, goal: g.targetAmount, pct };
              }) : GOAL_TILES_FALLBACK.map(t => ({ label: t.label, icon: t.icon, tileClass: t.tileClass, amount: t.amount, goal: t.goal, pct: t.goal ? Math.round((t.amount / t.goal) * 100) : 0 }))
              ).map((tile, i, arr) => (
                <div key={tile.label}>
                  <div className="bunq-account-row">
                    <div className={`bunq-tile ${tile.tileClass}`} style={{ width: '54px', height: '54px', fontSize: '26px' }}>
                      {tile.icon}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '17px', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>
                        {tile.label}
                      </div>
                      {tile.goal !== undefined && (
                        <div style={{ marginTop: '7px', height: '3px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                          <div style={{
                            height: '100%',
                            width: `${Math.min(tile.pct, 100)}%`,
                            background: '#00ff95',
                            borderRadius: '2px',
                            transition: 'width 1.2s cubic-bezier(0.4,0,0.2,1)',
                          }} />
                        </div>
                      )}
                    </div>
                    <BunqBalance amount={tile.amount} currency="€" intSize={19} />
                  </div>
                  {i < arr.length - 1 && <div className="bunq-divider" />}
                </div>
              ))}

              <div style={{ height: '16px' }} />
            </div>

          </div>

          {/* ── CENTER COLUMN ───────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <OracleVotingPanel
              votes={sim.votes}
              verdict={sim.verdict}
              running={sim.running}
              onTriggerFraud={() => { void sim.runFraudOracle(); }}
            />

            {/* ── Multi-Account Intelligence (Phase 14) ─────────────────── */}
            {accountSummaries.length > 0 && (
              <div style={{
                background: 'rgba(255,255,255,0.042)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '22px',
                padding: '20px',
                animation: 'slideUp 0.4s ease',
              }}>
                <div className="section-label" style={{ marginBottom: '14px' }}>
                  All Accounts
                  <span style={{
                    marginLeft: '8px', fontSize: '9px', fontWeight: 700,
                    padding: '2px 7px', borderRadius: '100px',
                    background: 'rgba(0,191,255,0.12)',
                    color: '#00bfff', letterSpacing: '0.1em',
                    verticalAlign: 'middle',
                  }}>LIVE</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {accountSummaries.map((s) => {
                    const classColor: Record<string, string> = {
                      primary: '#1A82C4',
                      savings: '#2DA845',
                      joint:   '#C4890A',
                      other:   '#64748B',
                    };
                    const classIcon: Record<string, string> = {
                      primary: '🏦',
                      savings: '🐷',
                      joint:   '👫',
                      other:   '💳',
                    };
                    const col  = classColor[s.classification] ?? '#64748B';
                    const icon = classIcon[s.classification]  ?? '💳';
                    const balEur = s.balanceCents / 100;
                    return (
                      <div key={s.account.id} style={{
                        display: 'flex', alignItems: 'center', gap: '12px',
                        padding: '12px 14px',
                        background: 'rgba(255,255,255,0.025)',
                        border: `1px solid ${col}28`,
                        borderLeft: `3px solid ${col}`,
                        borderRadius: '14px',
                        position: 'relative',
                      }}>
                        <div style={{
                          width: '40px', height: '40px', borderRadius: '12px',
                          background: `${col}22`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '20px', flexShrink: 0,
                        }}>
                          {icon}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '13px', fontWeight: 600, color: '#E2E8F0', letterSpacing: '-0.01em' }}>
                              {s.label}
                            </span>
                            <span style={{
                              fontSize: '8px', fontWeight: 700, padding: '1px 5px',
                              borderRadius: '4px', background: `${col}22`, color: col,
                              letterSpacing: '0.08em', textTransform: 'uppercase',
                            }}>
                              {s.classification}
                            </span>
                            {s.unusualSpendFlag && (
                              <span style={{ fontSize: '11px' }} title="Unusual spend detected">⚠️</span>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)' }}>
                              {s.recentTxCount} tx · 7d
                            </span>
                            {s.goalLinked && s.goalProgress !== null && (
                              <div style={{ flex: 1, maxWidth: '80px', height: '3px', background: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden' }}>
                                <div style={{
                                  height: '100%', width: `${Math.round(s.goalProgress * 100)}%`,
                                  background: '#00ff95', borderRadius: '2px',
                                }} />
                              </div>
                            )}
                            {s.goalLinked && s.goalProgress !== null && (
                              <span style={{ fontSize: '10px', color: '#00ff95', fontWeight: 600 }}>
                                {Math.round(s.goalProgress * 100)}%
                              </span>
                            )}
                          </div>
                        </div>
                        <BunqBalance amount={balEur} currency={s.currency} intSize={17} />
                      </div>
                    );
                  })}
                </div>
                <div style={{
                  marginTop: '12px', paddingTop: '12px',
                  borderTop: '1px solid rgba(255,255,255,0.06)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)' }}>
                    Total across {accountSummaries.length} account{accountSummaries.length !== 1 ? 's' : ''}
                  </span>
                  <BunqBalance
                    amount={accountSummaries.reduce((sum, s) => sum + s.balanceCents, 0) / 100}
                    currency="€"
                    intSize={18}
                  />
                </div>
              </div>
            )}

            <ForecastChart />
          </div>

          {/* ── RIGHT COLUMN ────────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

            {/* ── Spending This Month ── live when daemon has data, fallback otherwise */}
            <div style={{
              background: 'rgba(255,255,255,0.042)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '22px',
              padding: '20px 20px 16px',
            }}>
              <div className="section-label" style={{ marginBottom: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{weeklySpending && weeklySpending.some(d => d.amount > 0) ? 'Spending This Week' : 'Spending This Month'}</span>
                {weeklySpending && weeklySpending.some(d => d.amount > 0) && (
                  <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '100px', background: 'rgba(0,191,255,0.12)', color: '#00bfff', letterSpacing: '0.08em' }}>LIVE</span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {weeklySpending && weeklySpending.some(d => d.amount > 0)
                  ? (() => {
                      const max = Math.max(...weeklySpending.map(d => d.amount), 1);
                      const dayColors: Record<string, string> = { Mon: '#7A5200', Tue: '#6A1A8A', Wed: '#1A4480', Thu: '#1A4D2E', Fri: '#8B5A00', Sat: '#4A1A6A', Sun: '#1A3454' };
                      const dayIcons: Record<string, string> = { Mon: '📅', Tue: '📅', Wed: '📅', Thu: '📅', Fri: '🎉', Sat: '🍽️', Sun: '☕' };
                      return weeklySpending.map(d => {
                        const pct = Math.max(18, Math.round((d.amount / max) * 70));
                        return (
                          <div key={d.day} style={{ display: 'flex', alignItems: 'center', height: '52px', gap: '0' }}>
                            <div style={{
                              flex: `0 0 ${pct}%`,
                              height: '100%',
                              borderRadius: '14px',
                              background: dayColors[d.day] ?? '#334155',
                              display: 'flex', alignItems: 'center',
                              gap: '10px', padding: '0 12px',
                              minWidth: '110px',
                              overflow: 'hidden',
                            }}>
                              <div className="bunq-cat-icon">{dayIcons[d.day] ?? '💸'}</div>
                              <div>
                                <div style={{ fontSize: '12px', fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>
                                  {d.day}
                                </div>
                                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.55)', marginTop: '2px' }}>
                                  {d.amount > 0 ? `${d.amount.toFixed(0)} spent` : 'No spend'}
                                </div>
                              </div>
                            </div>
                            <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', paddingRight: '4px' }}>
                              <BunqBalance amount={d.amount} currency="€" intSize={16} />
                            </div>
                          </div>
                        );
                      });
                    })()
                  : SPEND_CATS.map((cat) => (
                  <div key={cat.label} style={{ display: 'flex', alignItems: 'center', height: '62px', gap: '0' }}>
                    {/* Colored staggered bar */}
                    <div style={{
                      flex: `0 0 ${cat.pct}%`,
                      height: '100%',
                      borderRadius: '14px',
                      background: cat.bg,
                      display: 'flex', alignItems: 'center',
                      gap: '10px', padding: '0 12px',
                      minWidth: '130px',
                      overflow: 'hidden',
                    }}>
                      <div className="bunq-cat-icon">{cat.icon}</div>
                      <div>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>
                          {cat.label}
                        </div>
                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.55)', marginTop: '2px' }}>
                          {cat.txCount} transaction{cat.txCount !== 1 ? 's' : ''}
                        </div>
                      </div>
                    </div>
                    {/* Amount — right side, outside the bar */}
                    <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', paddingRight: '4px' }}>
                      <BunqBalance amount={cat.amount} currency="€" intSize={17} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Recent Transactions ────────────────────────────────────── */}
            <RecentTransactions refreshKey={txRefreshKey} />

            <DNACard />

            <ReceiptScanner onExpenseLogged={() => setTxRefreshKey(k => k + 1)} />

            {/* ── Detected Patterns ──────────────────────────────────────── */}
            <div style={{
              background: 'rgba(255,255,255,0.042)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '22px',
              padding: '20px',
            }}>
              <div className="section-label" style={{ marginBottom: '14px' }}>Detected Patterns</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {[
                  { pattern: 'Weekend dining spike',  confidence: 87, icon: '🍽️', color: '#FF8C00' },
                  { pattern: 'Monthly salary — 25th', confidence: 96, icon: '💼', color: '#00ff95' },
                  { pattern: 'Streaming sub spike',   confidence: 91, icon: '📺', color: '#00bfff' },
                ].map((p) => (
                  <div key={p.pattern} style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px 12px',
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.05)',
                    borderRadius: '12px',
                  }}>
                    <span style={{ fontSize: '16px' }}>{p.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '11px', color: '#CBD5E1', fontWeight: 500, marginBottom: '5px' }}>{p.pattern}</div>
                      <div style={{ height: '3px', background: 'rgba(255,255,255,0.07)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', width: `${p.confidence}%`,
                          background: p.color, borderRadius: '2px',
                          transition: 'width 1.2s cubic-bezier(0.4,0,0.2,1)',
                        }} />
                      </div>
                    </div>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: p.color }}>{p.confidence}%</div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      </>)}
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer style={{
        borderTop: '1px solid rgba(255,255,255,0.05)',
        padding: '16px 28px', fontSize: '11px',
        color: 'rgba(255,255,255,0.16)', position: 'relative', zIndex: 1,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
          <span style={{
            fontFamily: "'Montserrat', sans-serif", fontWeight: 800, fontSize: '12px',
            background: 'linear-gradient(135deg,#00bfff,#00ff95)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          }}>BUNQSY</span>
          <span>bunq Hackathon 7.0</span>
          <span>·</span>
          <span>Claude + bunq API</span>
        </div>

        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <button className="demo-reset-btn" onClick={() => { void handleDemoReset(); }}>
            ⟳ reset demo
          </button>
          <button
            className="demo-reset-btn"
            disabled={fundingState === 'loading' || fundingState === 'done'}
            onClick={async () => {
              setFundingState('loading');
              try {
                const res = await fetch('/api/demo/fund-sandbox', { method: 'POST' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                setFundingState('done');
                setTxRefreshKey(k => k + 1);
                setTimeout(() => setFundingState('idle'), 6000);
              } catch {
                setFundingState('error');
                setTimeout(() => setFundingState('idle'), 4000);
              }
            }}
          >
            {fundingState === 'loading' ? '⏳ requesting…'
              : fundingState === 'done'  ? '✓ €500 funded'
              : fundingState === 'error' ? '⚠ failed'
              : '💶 fund sandbox'}
          </button>
        </div>
      </footer>

      {/* ── Fraud block overlay ─────────────────────────────────────────────── */}
      {sim.fraudModalOpen && (
        <FraudBlock
          onAllow={() => { sim.setFraudModalOpen(false); sim.resetOracle(); }}
          onBlock={() => { sim.setFraudModalOpen(false); sim.resetOracle(); }}
          title="Suspicious Transaction Detected"
          narration="Fraud Shadow triggered INTERVENE at 92% confidence. 2AM foreign transaction to Unknown LLC for round amount in USD — four concurrent fraud signals detected."
        />
      )}

      {dreamModalOpen && dreamBriefing && (
        <DreamBriefingModal briefing={dreamBriefing} onClose={() => setDreamModalOpen(false)} />
      )}
    </div>
  );
}
