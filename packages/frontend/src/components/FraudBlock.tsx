import React, { useState, useEffect, useRef } from 'react';

interface Props {
  onAllow: () => void;
  onBlock: () => void;
  title?: string;
  narration?: string;
}

const fraudSignals = [
  { label: 'Transaction outside normal hours', detected: true },
  { label: 'New payee — never transacted before', detected: true },
  { label: 'Foreign currency unusual for profile', detected: true },
  { label: 'Round amount — common fraud pattern', detected: true },
  { label: 'Amount within normal range', detected: false },
  { label: 'Device recognised', detected: false },
];

function HoldButton({ label, color, bgColor, onComplete }: {
  label: string;
  color: string;
  bgColor: string;
  onComplete: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const intervalRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const HOLD_DURATION = 2000;

  const startHold = () => {
    setHolding(true);
    startRef.current = Date.now();
    intervalRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const pct = Math.min(100, (elapsed / HOLD_DURATION) * 100);
      setProgress(pct);
      if (pct >= 100) {
        if (intervalRef.current !== null) clearInterval(intervalRef.current);
        setHolding(false);
        setProgress(0);
        onComplete();
      }
    }, 16);
  };

  const stopHold = () => {
    if (intervalRef.current !== null) clearInterval(intervalRef.current);
    setHolding(false);
    setProgress(0);
  };

  return (
    <button
      onMouseDown={startHold}
      onMouseUp={stopHold}
      onMouseLeave={stopHold}
      onTouchStart={startHold}
      onTouchEnd={stopHold}
      style={{
        flex: 1,
        position: 'relative',
        background: bgColor,
        border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
        borderRadius: '14px',
        padding: '16px',
        color,
        fontSize: '14px',
        fontWeight: 700,
        cursor: 'pointer',
        overflow: 'hidden',
        transition: 'transform 0.1s',
        transform: holding ? 'scale(0.98)' : 'scale(1)',
        userSelect: 'none',
      }}
    >
      <div style={{
        position: 'absolute',
        inset: 0,
        background: color + '20',
        transformOrigin: 'left',
        transform: `scaleX(${progress / 100})`,
        transition: 'none',
        borderRadius: '14px',
      }} />
      <span style={{ position: 'relative', zIndex: 1 }}>
        {holding ? `Confirming... ${Math.round(progress)}%` : label}
      </span>
    </button>
  );
}

export function FraudBlock({ onAllow, onBlock, title, narration }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.85)',
      backdropFilter: 'blur(12px)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      opacity: visible ? 1 : 0,
      transition: 'opacity 0.3s ease',
    }}>
      <div className="glass" style={{
        border: '1px solid rgba(255,71,87,0.4)',
        padding: '36px',
        maxWidth: '520px',
        width: '100%',
        boxShadow: '0 0 80px rgba(255,71,87,0.2), 0 40px 80px rgba(0,0,0,0.8)',
        transform: visible ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.96)',
        transition: 'transform 0.4s ease',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{
            fontSize: '48px',
            marginBottom: '12px',
            animation: 'shake 0.5s ease',
          }}>⚠️</div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#FF4757', marginBottom: '6px' }}>
            {title || 'Suspicious Transaction Detected'}
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            Fraud Shadow sub-agent flagged this with 92% confidence
          </div>
        </div>

        <div style={{
          background: 'rgba(255,71,87,0.06)',
          border: '1px solid rgba(255,71,87,0.15)',
          borderRadius: '14px',
          padding: '16px',
          marginBottom: '20px',
        }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Transaction Details
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            {[
              { label: 'Amount', value: '€500.00 (USD)' },
              { label: 'Time', value: '02:14 AM' },
              { label: 'Merchant', value: 'Unknown LLC' },
              { label: 'Country', value: '🇺🇸 United States' },
            ].map(item => (
              <div key={item.label}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 500 }}>{item.label}</div>
                <div style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>{item.value}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Fraud Signal Checklist
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {fraudSignals.map((signal, i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                fontSize: '12px',
                color: signal.detected ? '#FF6B7A' : 'var(--text-muted)',
              }}>
                <span style={{ fontSize: '14px' }}>{signal.detected ? '🔴' : '🟢'}</span>
                <span style={{ textDecoration: signal.detected ? 'none' : 'line-through', opacity: signal.detected ? 1 : 0.6 }}>
                  {signal.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div style={{
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid var(--ink-060)',
          borderRadius: '12px',
          padding: '14px',
          marginBottom: '24px',
          borderLeft: '3px solid #FF4757',
        }}>
          <div style={{ fontSize: '11px', color: '#FF4757', fontWeight: 700, marginBottom: '6px' }}>BUNQSY says:</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {narration || `"This transaction hit four simultaneous fraud signals — it's 2am, the merchant is brand new, the amount is a suspicious round number, and it's in a foreign currency. I recommend blocking until you can verify."`}
          </div>
        </div>

        <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', marginBottom: '12px' }}>
          Hold button for 2 seconds to confirm your choice
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <HoldButton
            label="I authorised this — Allow"
            color="#00C896"
            bgColor="rgba(0,200,150,0.08)"
            onComplete={onAllow}
          />
          <HoldButton
            label="Block this transaction"
            color="#FF4757"
            bgColor="rgba(255,71,87,0.08)"
            onComplete={onBlock}
          />
        </div>
      </div>
    </div>
  );
}
