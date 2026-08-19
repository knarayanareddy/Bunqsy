import { useState, useEffect, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CardSummary {
  id: number;
  type: string | null;
  cardEndpoint: string;
  status: string | null;
  nameOnCard: string | null;
  lastFourDigits: string | null;
  expiryDate: string | null;
}

interface BunqGoalSummary {
  id: number;
  name: string;
  targetAmount: number;
  currentAmount: number;
  currency: string;
  status: string;
  source: 'bunq';
}

type FreezeState = 'idle' | 'confirming' | 'executing' | 'done' | 'error';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cardTypeLabel(type: string | null): string {
  if (!type) return 'Card';
  if (type.includes('MAESTRO'))   return 'Maestro';
  if (type.includes('MASTERCARD')) return 'Mastercard';
  if (type.includes('VIRTUAL'))   return 'Virtual';
  return type;
}

function cardTypeIcon(type: string | null): string {
  if (!type) return '💳';
  if (type.includes('VIRTUAL')) return '🌐';
  if (type.includes('MAESTRO'))  return '💳';
  return '💳';
}

function cardGradient(type: string | null, idx: number): string {
  const gradients = [
    'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
    'linear-gradient(135deg, #0d1b2a 0%, #1b2838 50%, #2c3e50 100%)',
    'linear-gradient(135deg, #1a0533 0%, #2d0a5e 50%, #1a1a3e 100%)',
    'linear-gradient(135deg, #0a2e1a 0%, #0d4a2a 50%, #0a3020 100%)',
  ];
  return gradients[idx % gradients.length] ?? gradients[0]!;
}

function statusColor(status: string | null): { color: string; bg: string; label: string } {
  if (status === 'ACTIVE')       return { color: 'var(--hue-green)', bg: 'rgba(34,197,94,0.15)',  label: 'ACTIVE' };
  if (status === 'DEACTIVATED')  return { color: '#ef4444', bg: 'rgba(239,68,68,0.15)',  label: 'FROZEN' };
  if (status === 'CANCELLED_BY_USER') return { color: '#ef4444', bg: 'rgba(239,68,68,0.15)', label: 'FROZEN' };
  if (status === 'LOST')         return { color: 'var(--hue-orange)', bg: 'rgba(249,115,22,0.15)', label: 'LOST' };
  if (status === 'STOLEN')       return { color: '#dc2626', bg: 'rgba(220,38,38,0.15)',  label: 'STOLEN' };
  return { color: 'var(--hue-slate)', bg: 'rgba(148,163,184,0.12)', label: status ?? 'UNKNOWN' };
}

function isFrozen(status: string | null): boolean {
  return status === 'DEACTIVATED' || status === 'CANCELLED_BY_USER';
}

// ─── Single Card ──────────────────────────────────────────────────────────────

function BunqCard({ card, idx, onRefresh, isSandboxDemo = false }: {
  card: CardSummary;
  idx: number;
  onRefresh: () => void;
  isSandboxDemo?: boolean;
}): React.JSX.Element {
  const [freezeState, setFreezeState] = useState<FreezeState>('idle');
  const [planId,      setPlanId]      = useState<string | null>(null);
  const [narration,   setNarration]   = useState<string>('');
  const [localStatus, setLocalStatus] = useState<string | null>(card.status);

  const frozen  = isFrozen(localStatus);
  const st      = statusColor(localStatus);
  const cardLabel = cardTypeLabel(card.type);

  async function handleFreezeClick(): Promise<void> {
    if (freezeState === 'confirming') {
      // Second tap — execute the plan
      if (!planId) return;
      setFreezeState('executing');
      try {
        const res = await fetch(`/api/confirm/${planId}`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setLocalStatus(frozen ? 'ACTIVE' : 'DEACTIVATED');
        setFreezeState('done');
        setTimeout(() => { setFreezeState('idle'); setPlanId(null); onRefresh(); }, 2500);
      } catch {
        setFreezeState('error');
        setTimeout(() => setFreezeState('idle'), 3000);
      }
      return;
    }

    if (freezeState !== 'idle') return;

    const endpoint = frozen ? 'unfreeze' : 'freeze';
    try {
      const res = await fetch(`/api/cards/${card.id}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardEndpoint:   card.cardEndpoint,
          nameOnCard:     card.nameOnCard ?? cardLabel,
          lastFourDigits: card.lastFourDigits ?? '****',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { planId: string; narratedText: string };
      setPlanId(data.planId);
      setNarration(data.narratedText);
      setFreezeState('confirming');
    } catch {
      setFreezeState('error');
      setTimeout(() => setFreezeState('idle'), 2000);
    }
  }

  async function handleCancel(): Promise<void> {
    if (planId) {
      await fetch(`/api/confirm/${planId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'allow' }),
      }).catch(() => {});
    }
    setFreezeState('idle');
    setPlanId(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Card face */}
      <div style={{
        borderRadius: 20,
        background: cardGradient(card.type, idx),
        border: '1px solid var(--ink-100)',
        padding: '20px 22px',
        position: 'relative',
        overflow: 'hidden',
        minHeight: 170,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        boxShadow: frozen ? '0 4px 20px rgba(239,68,68,0.15)' : '0 8px 32px rgba(0,0,0,0.4)',
        transition: 'box-shadow 0.3s',
      }}>
        {/* Frosted overlay when frozen */}
        {frozen && (
          <div style={{
            position: 'absolute', inset: 0, borderRadius: 20,
            background: 'rgba(239,68,68,0.06)',
            backdropFilter: 'blur(1px)',
            pointerEvents: 'none',
          }} />
        )}

        {/* bunq rainbow strip — top edge */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 3,
          background: 'linear-gradient(90deg, #ef4444 0%, var(--hue-orange) 17%, var(--hue-yellow) 33%, var(--hue-green) 50%, #3b82f6 67%, #6366f1 83%, #a855f7 100%)',
          borderRadius: '20px 20px 0 0',
        }} />

        {/* Top row: bunq logo + badges */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--card-ink)', letterSpacing: '-0.02em', fontFamily: "'Montserrat', sans-serif" }}>
            bunq
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {isSandboxDemo && (
              <div style={{
                fontSize: 8, fontWeight: 800, padding: '2px 7px', borderRadius: 100,
                background: 'rgba(234,179,8,0.15)', color: 'var(--hue-yellow)',
                letterSpacing: '0.12em', border: '1px solid rgba(234,179,8,0.25)',
              }}>
                SANDBOX
              </div>
            )}
            <div style={{
              fontSize: 9, fontWeight: 800, padding: '3px 10px', borderRadius: 100,
              background: st.bg, color: st.color, letterSpacing: '0.12em',
            }}>
              {st.label}
            </div>
          </div>
        </div>

        {/* Card chip */}
        <div style={{
          width: 36, height: 28, borderRadius: 5,
          background: 'linear-gradient(135deg, #c8a95b 0%, #e8c97a 40%, #b8913a 100%)',
          border: '1px solid var(--card-line)',
        }} />

        {/* PAN + details */}
        <div>
          <div style={{
            fontSize: 16, fontWeight: 600, color: 'var(--card-ink-dim)',
            letterSpacing: '0.18em', marginBottom: 8,
            fontFamily: "'Montserrat', monospace",
          }}>
            ●●●● &nbsp;●●●● &nbsp;●●●● &nbsp;{card.lastFourDigits ?? '····'}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: 8, color: 'var(--card-ink-faint)', letterSpacing: '0.10em', marginBottom: 2 }}>CARD HOLDER</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--card-ink-dim)', letterSpacing: '0.04em' }}>
                {card.nameOnCard ?? 'BUNQSY USER'}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 8, color: 'var(--card-ink-faint)', letterSpacing: '0.10em', marginBottom: 2 }}>EXPIRES</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--card-ink-dim)' }}>
                {card.expiryDate ?? '••/••'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Action area below card */}
      <div style={{
        background: 'var(--ink-025)',
        border: '1px solid var(--ink-060)',
        borderTop: 'none',
        borderRadius: '0 0 16px 16px',
        padding: '12px 16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-strong)' }}>
              {cardTypeIcon(card.type)} {cardLabel}
            </div>
            <div style={{ fontSize: 10, color: 'var(--ink-320)', marginTop: 2 }}>
              {frozen ? 'Card is currently frozen' : 'Tap to freeze for extra security'}
            </div>
          </div>

          {freezeState === 'done' ? (
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--hue-green)' }}>
              {frozen ? '✓ Frozen' : '✓ Active'}
            </div>
          ) : freezeState === 'error' ? (
            <div style={{ fontSize: 11, color: '#ef4444' }}>Failed</div>
          ) : (
            <button
              onClick={() => { void handleFreezeClick(); }}
              disabled={freezeState === 'executing'}
              style={{
                padding: '7px 16px', borderRadius: 100, border: 'none', cursor: 'pointer',
                background: frozen ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.12)',
                color: frozen ? 'var(--hue-green)' : '#ef4444',
                fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
                opacity: freezeState === 'executing' ? 0.6 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              {freezeState === 'executing' ? '…' : frozen ? 'Unfreeze' : 'Freeze'}
            </button>
          )}
        </div>

        {/* Inline confirmation panel */}
        {freezeState === 'confirming' && (
          <div style={{
            marginTop: 12, padding: '12px 14px', borderRadius: 12,
            background: frozen ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
            border: `1px solid ${frozen ? 'rgba(34,197,94,0.20)' : 'rgba(239,68,68,0.20)'}`,
            borderLeft: `3px solid ${frozen ? 'var(--hue-green)' : '#ef4444'}`,
          }}>
            {/* Plan narration */}
            <div style={{ fontSize: 11, color: 'var(--ink-650)', lineHeight: 1.55, marginBottom: 10 }}>
              {narration}
            </div>
            <div style={{ fontSize: 9, color: 'var(--ink-250)', marginBottom: 10 }}>
              🔍 Narrated by Claude · PLAN → CONFIRM → EXECUTE
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { void handleFreezeClick(); }}
                style={{
                  flex: 1, padding: '8px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: frozen ? 'var(--hue-green)' : '#ef4444', color: 'var(--text-on-accent)',
                  fontSize: 12, fontWeight: 700,
                }}
              >
                {frozen ? 'Confirm Unfreeze' : 'Confirm Freeze'}
              </button>
              <button
                onClick={() => { void handleCancel(); }}
                style={{
                  padding: '8px 16px', borderRadius: 10, cursor: 'pointer',
                  background: 'var(--ink-070)', border: '1px solid var(--ink-100)',
                  color: 'var(--ink-500)', fontSize: 12, fontWeight: 600,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── bunq Goals ───────────────────────────────────────────────────────────────

function BunqGoalsSection({ goals }: { goals: BunqGoalSummary[] }): React.JSX.Element | null {
  if (goals.length === 0) return null;

  return (
    <div style={{
      background: 'var(--ink-042)',
      border: '1px solid var(--ink-080)',
      borderRadius: 22,
      padding: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--hue-teal)' }}>
          bunq Savings Goals
        </div>
        <div style={{
          fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 100,
          background: 'rgba(34,197,94,0.12)', color: 'var(--hue-green)', letterSpacing: '0.08em',
        }}>
          LIVE
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {goals.map((g) => {
          const pct = g.targetAmount > 0 ? Math.min((g.currentAmount / g.targetAmount) * 100, 100) : 0;
          return (
            <div key={g.id} style={{
              padding: '14px 16px', borderRadius: 16,
              background: 'var(--ink-025)',
              border: '1px solid var(--ink-060)',
              borderLeft: '3px solid var(--hue-green)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-strong)' }}>🎯 {g.name}</div>
                <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--hue-green)' }}>
                  {g.currency}{g.currentAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
              </div>
              <div style={{ height: 5, background: 'var(--ink-070)', borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
                <div style={{
                  height: '100%', borderRadius: 3, width: `${pct}%`,
                  background: 'linear-gradient(90deg, var(--hue-green), var(--hue-emerald))',
                  transition: 'width 1s cubic-bezier(0.4,0,0.2,1)',
                  boxShadow: '0 0 8px rgba(34,197,94,0.4)',
                }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ink-350)' }}>
                <span>{Math.round(pct)}% of goal</span>
                <span>Target: {g.currency}{g.targetAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main CardsPanel ──────────────────────────────────────────────────────────

export function CardsPanel(): React.JSX.Element {
  const [cards,    setCards]    = useState<CardSummary[]>([]);
  const [goals,    setGoals]    = useState<BunqGoalSummary[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  const fetchCards = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/cards');
      if (res.ok) {
        setCards(await res.json() as CardSummary[]);
        setError(null);
      } else {
        const body = await res.json() as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
      }
    } catch {
      setError('Daemon offline');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchGoals = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/bunq-goals');
      if (res.ok) setGoals(await res.json() as BunqGoalSummary[]);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    void fetchCards();
    void fetchGoals();
    const t = setInterval(() => { void fetchCards(); void fetchGoals(); }, 30_000);
    return () => clearInterval(t);
  }, [fetchCards, fetchGoals]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>
            Cards
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-400)', marginTop: 3 }}>
            Live from bunq · freeze or manage below
          </div>
        </div>
        <div style={{
          fontSize: 9, fontWeight: 700, padding: '4px 12px', borderRadius: 100,
          background: 'rgba(59,130,246,0.12)', color: '#3b82f6',
          border: '1px solid rgba(59,130,246,0.25)', letterSpacing: '0.10em',
        }}>
          bunq API
        </div>
      </div>

      {/* Cards grid */}
      {loading ? (
        <div style={{
          padding: '40px 0', textAlign: 'center',
          color: 'var(--ink-280)', fontSize: 13,
        }}>
          Fetching cards from bunq…
        </div>
      ) : error ? (
        <div style={{
          padding: '32px 20px', borderRadius: 22,
          background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 13, color: '#ef4444', marginBottom: 6 }}>Unable to load cards</div>
          <div style={{ fontSize: 11, color: 'var(--ink-350)' }}>{error}</div>
          <div style={{ fontSize: 10, color: 'var(--ink-220)', marginTop: 8 }}>
            Start the daemon and ensure BUNQ_API_KEY is set
          </div>
        </div>
      ) : cards.length === 0 ? (
        <div style={{
          padding: '40px 0', textAlign: 'center',
          color: 'var(--ink-280)', fontSize: 13,
        }}>
          No cards found on this bunq account
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 20,
        }}>
          {cards.map((card, idx) => (
            <BunqCard
              key={card.id}
              card={card}
              idx={idx}
              onRefresh={() => { void fetchCards(); }}
              isSandboxDemo={card.id >= 99000}
            />
          ))}
        </div>
      )}

      {/* bunq native savings goals */}
      <BunqGoalsSection goals={goals} />

      {/* Constitutional note */}
      <div style={{
        padding: '12px 16px', borderRadius: 14,
        background: 'rgba(59,130,246,0.04)',
        border: '1px solid rgba(59,130,246,0.10)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontSize: 14 }}>🛡</span>
        <div style={{ fontSize: 10, color: 'var(--ink-350)', lineHeight: 1.5 }}>
          All card actions require explicit confirmation via the PLAN → CONFIRM → EXECUTE gateway.
          BUNQSY never writes to bunq without your consent. Constitutional Rule #1 & #2.
        </div>
      </div>
    </div>
  );
}
