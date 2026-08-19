import { useState } from 'react';

export interface DreamBriefingType {
  sessionId: string;
  briefingText: string;
  dnaCard: string;
  suggestions: string[];
  completedAt: string;
}

interface DreamTriggerProps {
  running: boolean;
  onTrigger: () => void;
}

export function DreamTrigger({ running, onTrigger }: DreamTriggerProps) {
  return (
    <button
      onClick={onTrigger}
      disabled={running}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: running
          ? 'rgba(0,191,255,0.06)'
          : 'linear-gradient(135deg, rgba(0,191,255,0.12), rgba(0,255,149,0.10))',
        border: `1px solid ${running ? 'rgba(0,191,255,0.18)' : 'rgba(0,191,255,0.32)'}`,
        borderRadius: '100px',
        padding: '7px 16px',
        color: running ? 'var(--accent-cyan)' : 'var(--accent-cyan)',
        fontSize: '12px',
        fontWeight: 600,
        fontFamily: "'Montserrat', sans-serif",
        letterSpacing: '0.02em',
        cursor: running ? 'not-allowed' : 'pointer',
        transition: 'all 0.3s',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <span style={{
        fontSize: '16px',
        animation: running ? 'spin 3s linear infinite' : 'none',
      }}>
        {running ? '🌙' : '💤'}
      </span>
      <span>{running ? 'Dreaming...' : 'Trigger Dream Mode'}</span>
      {running && (
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          height: '2px',
          background: 'linear-gradient(90deg, var(--accent-cyan), var(--accent-green))',
          animation: 'loadingBar 3s ease infinite',
          width: '100%',
        }} />
      )}
    </button>
  );
}

interface BriefingModalProps {
  briefing: DreamBriefingType;
  onClose: () => void;
}

export function DreamBriefingModal({ briefing, onClose }: BriefingModalProps) {
  const [visible, setVisible] = useState(true);

  const handleClose = () => {
    setVisible(false);
    setTimeout(onClose, 300);
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(12px)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      opacity: visible ? 1 : 0,
      transition: 'opacity 0.3s ease',
    }}>
      <div style={{
        background: 'var(--modal-grad)',
        border: '1px solid rgba(0,191,255,0.18)',
        borderRadius: '28px',
        padding: '40px',
        maxWidth: '560px',
        width: '100%',
        boxShadow: '0 0 80px var(--accent-cyan-glow), var(--shadow-modal)',
        transform: visible ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.96)',
        transition: 'transform 0.4s ease',
        maxHeight: '90vh',
        overflowY: 'auto',
      }}>
        {/* Stars background effect */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{ fontSize: '48px', marginBottom: '8px' }}>🌙</div>
          <div style={{ fontSize: '11px', color: 'var(--accent-cyan)', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '6px', fontFamily: "'Montserrat', sans-serif" }}>
            DREAM MODE COMPLETE
          </div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#F1F5F9' }}>
            Your Morning Briefing
          </div>
          <div style={{ fontSize: '11px', color: '#334155', marginTop: '4px' }}>
            {new Date(briefing.completedAt).toLocaleString()}
          </div>
        </div>

        {/* Briefing text */}
        <div style={{
          background: 'rgba(0,191,255,0.05)',
          border: '1px solid rgba(0,191,255,0.14)',
          borderRadius: '16px',
          padding: '20px',
          marginBottom: '20px',
          fontSize: '14px',
          color: 'var(--text-soft)',
          lineHeight: 1.7,
          fontStyle: 'italic',
          borderLeft: '3px solid var(--accent-cyan)',
        }}>
          "{briefing.briefingText}"
        </div>

        {/* Financial DNA Card */}
        <div style={{ marginBottom: '20px' }}>
          <div style={{ fontSize: '11px', color: '#64748B', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '10px' }}>
            Your Financial DNA
          </div>
          <div style={{
            background: 'linear-gradient(135deg, rgba(0,191,255,0.12), rgba(0,255,149,0.08))',
            border: '1px solid rgba(0,191,255,0.22)',
            borderRadius: '14px',
            padding: '16px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}>
            <div style={{ fontSize: '28px' }}>🧬</div>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--accent-cyan)', fontWeight: 600, marginBottom: '3px' }}>Identified from your patterns</div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-strong)' }}>
                {briefing.dnaCard}
              </div>
            </div>
          </div>
        </div>

        {/* Suggestions */}
        <div style={{ marginBottom: '28px' }}>
          <div style={{ fontSize: '11px', color: '#64748B', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '10px' }}>
            3 Actionable Suggestions
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {briefing.suggestions.map((s, i) => (
              <div key={i} style={{
                display: 'flex',
                gap: '12px',
                padding: '14px 16px',
                background: 'var(--ink-030)',
                border: '1px solid var(--ink-060)',
                borderRadius: '12px',
              }}>
                <div style={{
                  width: '22px',
                  height: '22px',
                  borderRadius: '50%',
                  background: 'rgba(0,191,255,0.15)',
                  border: '1px solid rgba(0,191,255,0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '11px',
                  fontWeight: 700,
                  color: 'var(--accent-cyan)',
                  flexShrink: 0,
                  marginTop: '1px',
                }}>
                  {i + 1}
                </div>
                <div style={{ fontSize: '13px', color: 'var(--hue-slate)', lineHeight: 1.5 }}>{s}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Dismiss */}
        <button
          onClick={handleClose}
          style={{
            width: '100%',
            background: 'linear-gradient(135deg, var(--accent-cyan), var(--accent-green))',
            border: 'none',
            borderRadius: '14px',
            padding: '16px',
            color: 'var(--text-primary)',
            fontSize: '15px',
            fontWeight: 700,
            cursor: 'pointer',
            transition: 'opacity 0.2s',
          }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          Got it — start my day ✓
        </button>
      </div>
    </div>
  );
}
