import React, { useState } from 'react';
import type { SimVote, SimVerdict } from '../hooks/useLocalSim.js';

interface Props {
  votes: SimVote[];
  verdict: SimVerdict | null;
  running: boolean;
  onTriggerFraud: () => void;
}

const statusStyles: Record<SimVote['status'], { color: string; bg: string; label: string }> = {
  PENDING:   { color: '#475569',  bg: 'rgba(71,85,105,0.08)',   label: '○ IDLE'       },
  RUNNING:   { color: 'var(--hue-orange)',  bg: 'rgba(255,106,0,0.08)',   label: '◐ RUNNING'    },
  CLEAR:     { color: 'var(--accent-green)',  bg: 'rgba(0,255,149,0.08)',   label: '✓ CLEAR'      },
  WARN:      { color: 'var(--hue-orange)',  bg: 'rgba(255,106,0,0.08)',   label: '⚠ WARN'       },
  INTERVENE: { color: '#ff1500',  bg: 'rgba(255,21,0,0.08)',    label: '🚨 INTERVENE' },
};

export function OracleVotingPanel({ votes, verdict, running, onTriggerFraud }: Props): React.JSX.Element {
  const [fundState, setFundState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const isIdle = votes.every(v => v.status === 'PENDING');

  return (
    <div style={{
      background: 'var(--ink-040)',
      border: '1px solid var(--ink-080)',
      borderRadius: '20px',
      padding: '28px',
      display: 'flex',
      flexDirection: 'column',
      gap: '20px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '11px', letterSpacing: '0.12em', color: 'var(--ink-320)', fontWeight: 600, textTransform: 'uppercase', marginBottom: '4px' }}>
            RISK ORACLE
          </div>
          <div style={{ fontSize: '13px', color: 'var(--ink-550)' }}>6 independent sub-agents</div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            disabled={fundState === 'loading' || fundState === 'done'}
            onClick={async () => {
              setFundState('loading');
              try {
                const res = await fetch('/api/demo/fund-sandbox', { method: 'POST' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                setFundState('done');
                setTimeout(() => setFundState('idle'), 5000);
              } catch {
                setFundState('error');
                setTimeout(() => setFundState('idle'), 3000);
              }
            }}
            style={{
              background: fundState === 'done' ? 'rgba(0,255,149,0.10)' : 'rgba(0,255,149,0.10)',
              border: '1px solid rgba(0,255,149,0.30)',
              borderRadius: '100px',
              padding: '8px 16px',
              color: fundState === 'error' ? 'var(--hue-orange)' : 'var(--accent-green)',
              fontSize: '12px',
              fontWeight: 600,
              cursor: fundState === 'loading' || fundState === 'done' ? 'not-allowed' : 'pointer',
              opacity: fundState === 'loading' ? 0.6 : 1,
              transition: 'all 0.2s',
              fontFamily: "'Montserrat', sans-serif",
            }}
          >
            {fundState === 'loading' ? '⏳ Requesting…'
              : fundState === 'done'  ? '✓ €500 Funded'
              : fundState === 'error' ? '⚠ Failed'
              : '💰 Fund Sandbox'}
          </button>
          <button
            onClick={onTriggerFraud}
            disabled={running}
            style={{
              background: running ? 'var(--ink-040)' : 'rgba(255,21,0,0.10)',
              border: `1px solid ${running ? 'var(--ink-080)' : 'rgba(255,21,0,0.30)'}`,
              borderRadius: '100px',
              padding: '8px 16px',
              color: running ? '#475569' : '#ff1500',
              fontSize: '12px',
              fontWeight: 600,
              cursor: running ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
              fontFamily: "'Montserrat', sans-serif",
            }}
          >
            {running ? '⚡ Running...' : '⚡ Simulate Fraud'}
          </button>
        </div>
      </div>

      {/* Agent rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {votes.map((vote) => {
          const s = statusStyles[vote.status];
          return (
            <div
              key={vote.agent}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                background: vote.status !== 'PENDING' ? s.bg : 'var(--ink-020)',
                border: `1px solid ${vote.status !== 'PENDING' ? s.color + '28' : 'var(--ink-050)'}`,
                borderRadius: '12px',
                transition: 'all 0.3s ease',
              }}
            >
              <div style={{ fontSize: '20px', flexShrink: 0 }}>{vote.icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{vote.agent}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {vote.status !== 'PENDING' && vote.confidence > 0 && (
                      <span style={{ fontSize: '11px', color: 'var(--ink-350)' }}>
                        {vote.confidence}%
                      </span>
                    )}
                    <span style={{
                      fontSize: '10px',
                      fontWeight: 700,
                      color: s.color,
                      letterSpacing: '0.05em',
                      animation: vote.status === 'RUNNING' ? 'blink 1s infinite' : 'none',
                    }}>
                      {s.label}
                    </span>
                  </div>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--ink-300)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {vote.status === 'PENDING' ? 'Awaiting trigger...' : vote.message}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Verdict */}
      {verdict && (
        <div style={{
          background: verdict.status === 'INTERVENE'
            ? 'rgba(255,21,0,0.08)'
            : verdict.status === 'WARN'
              ? 'rgba(255,106,0,0.08)'
              : 'rgba(0,255,149,0.08)',
          border: `1px solid ${
            verdict.status === 'INTERVENE' ? 'rgba(255,21,0,0.30)'
            : verdict.status === 'WARN'    ? 'rgba(255,106,0,0.30)'
            :                                'rgba(0,255,149,0.30)'
          }`,
          borderRadius: '14px',
          padding: '16px',
          animation: 'slideUp 0.4s ease',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{
              fontSize: '13px',
              fontWeight: 800,
              color: verdict.status === 'INTERVENE' ? '#ff1500' : verdict.status === 'WARN' ? 'var(--hue-orange)' : 'var(--accent-green)',
              letterSpacing: '0.05em',
              fontFamily: "'Montserrat', sans-serif",
            }}>
              {verdict.status === 'INTERVENE' ? '🚨 VERDICT: INTERVENE' : verdict.status === 'WARN' ? '⚠️ VERDICT: WARN' : '✅ VERDICT: CLEAR'}
            </div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: verdict.status === 'INTERVENE' ? '#ff1500' : 'var(--ink-350)' }}>
              Risk Score: {verdict.riskScore}
            </div>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--ink-550)', lineHeight: 1.5 }}>
            {verdict.narration}
          </div>
        </div>
      )}

      {isIdle && (
        <div style={{ textAlign: 'center', padding: '8px', fontSize: '12px', color: 'var(--ink-180)', fontStyle: 'italic' }}>
          Oracle is monitoring quietly. Trigger a fraud event above to see it activate.
        </div>
      )}
    </div>
  );
}
