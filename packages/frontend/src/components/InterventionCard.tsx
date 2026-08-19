import React, { useState } from 'react';

interface Props {
  intervention: {
    title?: string;
    narration: string;
    riskScore?: number;
    severity?: 'LOW' | 'MEDIUM' | 'HIGH';
    actionLabel?: string;
    dismissLabel?: string;
  };
  onConfirm: () => void;
  onDismiss: () => void;
}

const SEVERITY_CFG = {
  LOW: {
    color: 'var(--accent-green)', glow: 'rgba(0,255,149,0.22)',
    border: 'rgba(0,255,149,0.28)', bg: 'rgba(0,255,149,0.04)',
    badgeBg: 'rgba(0,255,149,0.12)', icon: '✓', label: 'LOW RISK',
  },
  MEDIUM: {
    color: '#FF8C00', glow: 'rgba(255,140,0,0.22)',
    border: 'rgba(255,140,0,0.28)', bg: 'rgba(255,140,0,0.04)',
    badgeBg: 'rgba(255,140,0,0.12)', icon: '⚠', label: 'MODERATE',
  },
  HIGH: {
    color: '#FF3B30', glow: 'rgba(255,59,48,0.22)',
    border: 'rgba(255,59,48,0.28)', bg: 'rgba(255,59,48,0.04)',
    badgeBg: 'rgba(255,59,48,0.12)', icon: '🛑', label: 'HIGH RISK',
  },
} as const;

// bunq rainbow stripe — appears on all bunq notifications (ref: 18_security_limited_card.png)
const BUNQ_RAINBOW_GRADIENT =
  'linear-gradient(180deg,' +
  '#E53935 0%,#E53935 14.28%,' +
  '#FB8C00 14.28%,#FB8C00 28.57%,' +
  '#FDD835 28.57%,#FDD835 42.86%,' +
  '#43A047 42.86%,#43A047 57.14%,' +
  '#1E88E5 57.14%,#1E88E5 71.43%,' +
  '#3949AB 71.43%,#3949AB 85.71%,' +
  '#8E24AA 85.71%,#8E24AA 100%)';

export function InterventionCard({ intervention, onConfirm, onDismiss }: Props): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);

  const severityKey: keyof typeof SEVERITY_CFG =
    intervention.severity ??
    (intervention.riskScore !== undefined
      ? intervention.riskScore > 75 ? 'HIGH' : intervention.riskScore > 30 ? 'MEDIUM' : 'LOW'
      : 'MEDIUM');

  const s = SEVERITY_CFG[severityKey];

  const handleConfirm = async (): Promise<void> => {
    setConfirming(true);
    await onConfirm();
    setConfirming(false);
  };

  return (
    <div style={{
      position: 'relative',
      overflow: 'hidden',
      background: 'var(--glass-premium-bg)',
      backdropFilter: 'blur(48px) saturate(200%)',
      WebkitBackdropFilter: 'blur(48px) saturate(200%)',
      border: `1px solid ${s.border}`,
      borderRadius: '22px',
      padding: '22px 22px 22px 26px',
      animation: 'slideUp 0.38s cubic-bezier(0.34,1.56,0.64,1)',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
      boxShadow: `var(--shadow-modal), inset 0 1px 0 var(--ink-060)`,
    }}>

      {/* Left severity accent bar */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px',
        background: s.color,
        borderRadius: '22px 0 0 22px',
        boxShadow: `4px 0 20px ${s.glow}`,
      }} />

      {/* Tinted background wash */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: '22px',
        background: s.bg, pointerEvents: 'none',
      }} />

      {/* ── Card content ─────────────────────────────────────────────────── */}
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
            {/* bunq guardian badge row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{
                width: '26px', height: '26px', borderRadius: '7px', flexShrink: 0,
                background: BUNQ_RAINBOW_GRADIENT,
              }} />
              <span style={{
                fontSize: '10px', letterSpacing: '0.14em', fontWeight: 700,
                color: s.color, textTransform: 'uppercase',
              }}>
                BUNQSY GUARDIAN
              </span>
            </div>
            {/* Title */}
            <div style={{
              fontSize: '20px', fontWeight: 700, color: '#F1F5F9',
              letterSpacing: '-0.02em', lineHeight: 1.2,
            }}>
              {intervention.title ?? 'Action Required'}
            </div>
          </div>

          {/* Severity badge */}
          <div style={{
            padding: '5px 10px', borderRadius: '20px', flexShrink: 0, marginLeft: '12px', marginTop: '4px',
            background: s.badgeBg, border: `1px solid ${s.border}`,
            fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em',
            color: s.color, textTransform: 'uppercase', whiteSpace: 'nowrap',
          }}>
            {s.label}
          </div>
        </div>

        {/* Narration — styled as a bunq notification body (ref: 18_security_limited_card.png) */}
        <div style={{
          background: 'rgba(0,0,0,0.32)',
          border: `1px solid var(--ink-070)`,
          borderLeft: `3px solid ${s.color}`,
          borderRadius: '0 14px 14px 0',
          padding: '14px 16px',
          fontSize: '13px', color: 'var(--ink-740)', lineHeight: 1.65,
        }}>
          {intervention.narration}
        </div>

        {/* Explainability footer */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '5px',
          fontSize: '10px', color: 'var(--ink-240)',
          marginTop: '-6px',
        }}>
          <span>🔍</span>
          <span>Narrated by Claude · No black boxes · Constitutional rule #10</span>
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => { void handleConfirm(); }}
            disabled={confirming}
            style={{
              flex: 1, border: 'none', borderRadius: '14px', padding: '14px',
              background: s.color, color: 'var(--text-on-bright)',
              fontSize: '14px', fontWeight: 700, letterSpacing: '-0.01em',
              cursor: confirming ? 'not-allowed' : 'pointer',
              opacity: confirming ? 0.75 : 1,
              boxShadow: confirming ? 'none' : `0 8px 28px ${s.glow}`,
            }}
          >
            {confirming ? 'Processing…' : `${s.icon} ${intervention.actionLabel ?? 'Confirm Action'}`}
          </button>
          <button
            onClick={onDismiss}
            disabled={confirming}
            style={{
              background: 'var(--ink-060)', border: '1px solid var(--ink-100)',
              borderRadius: '14px', padding: '14px 20px',
              color: 'var(--ink-480)', fontSize: '14px', fontWeight: 600,
              cursor: confirming ? 'not-allowed' : 'pointer',
            }}
          >
            {intervention.dismissLabel ?? 'Dismiss'}
          </button>
        </div>

      </div>
    </div>
  );
}
