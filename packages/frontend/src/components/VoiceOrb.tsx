import { useState, useRef, useCallback, useEffect } from 'react';

type OrbState = 'idle' | 'recording' | 'processing' | 'speaking' | 'plan_ready' | 'error';

interface VoicePlan {
  kind: 'plan';
  planId: string;
  narratedText: string;
  steps: Array<{ id: string; type: string; description: string }>;
  transcript: string;
}

interface VoiceResponse {
  kind: 'response' | 'confirmed' | 'denied';
  action?: string;
  spokenResponse: string;
  transcript: string;
}

type VoiceResult = VoicePlan | VoiceResponse;

interface ActiveIntervention {
  id: string;
  planId?: string | null;
}

interface TurnEntry {
  role: 'user' | 'kairos';
  text: string;
}

interface Props {
  onPlanConfirmed?: (planId: string) => void;
  activeIntervention?: ActiveIntervention | null;
  onActionTriggered?: (action: string) => void;
}

// ─── AudioContext — created once on first user gesture, stays unlocked ───────

let sharedAudioCtx: AudioContext | null = null;

export function unlockAudio(): void {
  if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
  if (sharedAudioCtx.state === 'suspended') void sharedAudioCtx.resume();
}

// ─── TTS — decodes MP3 via Web Audio API (immune to autoplay policy) ─────────

export async function speakText(text: string): Promise<void> {
  try {
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.warn('[speakText] server error', res.status);
      return;
    }
    const arrayBuffer = await res.arrayBuffer();

    // Ensure we have a live AudioContext (created on user gesture via unlockAudio)
    if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
    if (sharedAudioCtx.state === 'suspended') await sharedAudioCtx.resume();

    const decoded = await sharedAudioCtx.decodeAudioData(arrayBuffer);
    const source  = sharedAudioCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(sharedAudioCtx.destination);

    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start(0);
    });
  } catch (err) {
    console.warn('[speakText]', err instanceof Error ? err.message : err);
  }
}

// ─── Silence detector ─────────────────────────────────────────────────────────

const SILENCE_RMS_THRESHOLD = 12;   // below this = silent (0–128 scale)
const SILENCE_HOLD_MS       = 2400; // stop after this much continuous silence
const MIN_RECORD_MS         = 1500; // never stop before this — avoids clipping short phrases

function createSilenceDetector(
  stream: MediaStream,
  onSilence: () => void,
): () => void {
  let ctx: AudioContext | null = null;
  let rafId = 0;
  let silentSince: number | null = null;
  const startedAt = Date.now();

  try {
    ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);

    const tick = (): void => {
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (const v of buf) sumSq += (v - 128) ** 2;
      const rms = Math.sqrt(sumSq / buf.length);

      if (rms < SILENCE_RMS_THRESHOLD) {
        if (!silentSince) silentSince = Date.now();
        const elapsed = Date.now() - startedAt;
        if (elapsed > MIN_RECORD_MS && Date.now() - silentSince > SILENCE_HOLD_MS) {
          onSilence();
          return; // stop the RAF loop
        }
      } else {
        silentSince = null;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  } catch { /* fallback: no silence detection */ }

  return () => {
    cancelAnimationFrame(rafId);
    ctx?.close().catch(() => {});
  };
}

// ─── Main component ───────────────────────────────────────────────────────────

export function VoiceOrb({ onPlanConfirmed, activeIntervention, onActionTriggered }: Props): React.JSX.Element {
  const [orbState,      setOrbState]      = useState<OrbState>('idle');
  const [plan,          setPlan]          = useState<VoicePlan | null>(null);
  const [errorMsg,      setErrorMsg]      = useState('');
  const [pendingPlanId, setPendingPlanId] = useState<string | null>(null);
  const [confirmingPlan, setConfirmingPlan] = useState(false);

  // Conversation mode state
  const [convMode,   setConvMode]   = useState(false);
  const [convActive, setConvActive] = useState(false);
  const [turns,      setTurns]      = useState<TurnEntry[]>([]);

  const mediaRecorderRef  = useRef<MediaRecorder | null>(null);
  const chunksRef         = useRef<BlobPart[]>([]);
  const streamRef         = useRef<MediaStream | null>(null);
  const stopSilenceRef    = useRef<(() => void) | null>(null);
  const convActiveRef     = useRef(false); // stable ref for async closures
  const stoppedRef        = useRef(false); // prevent double-stop

  // Keep ref in sync
  useEffect(() => { convActiveRef.current = convActive; }, [convActive]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      stopSilenceRef.current?.();
    };
  }, []);

  // ── Core recording logic ──────────────────────────────────────────────────

  const processAudio = useCallback(async (blob: Blob, mimeType: string): Promise<void> => {
    if (blob.size < 4000) {
      if (convActiveRef.current) {
        setOrbState('recording');
        void startRecordingInner();
      } else {
        setErrorMsg('Too short — try again');
        setOrbState('error');
        setTimeout(() => setOrbState('idle'), 2000);
      }
      return;
    }

    setOrbState('processing');

    try {
      const formData = new FormData();
      const ext = mimeType.includes('webm') ? '.webm' : '.mp4';
      formData.append('audio', blob, `voice${ext}`);
      if (pendingPlanId) formData.append('pendingPlanId', pendingPlanId);
      if (activeIntervention?.id)     formData.append('activeInterventionId',     activeIntervention.id);
      if (activeIntervention?.planId) formData.append('activeInterventionPlanId', activeIntervention.planId);

      const res  = await fetch('/api/voice', { method: 'POST', body: formData });
      const data = await res.json() as unknown;

      if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);

      const result = data as VoiceResult;

      if (result.kind === 'plan') {
        setPlan(result);
        setPendingPlanId(result.planId);
        setTurns(prev => [
          ...prev,
          { role: 'user',   text: result.transcript },
          { role: 'kairos', text: result.narratedText },
        ]);
        setOrbState('speaking');
        await speakText(result.narratedText);
        setOrbState('plan_ready');
        // In conversation mode: auto-listen so user can say "yes" or "no"
        if (convActiveRef.current) {
          await new Promise(r => setTimeout(r, 350));
          if (convActiveRef.current) void startRecordingInner();
        }
      } else {
        if (result.kind === 'confirmed' || result.kind === 'denied') setPendingPlanId(null);
        if (result.action) onActionTriggered?.(result.action);

        setTurns(prev => [
          ...prev,
          { role: 'user',   text: result.transcript },
          { role: 'kairos', text: result.spokenResponse },
        ]);

        setOrbState('speaking');
        await speakText(result.spokenResponse);

        // In conversation mode: automatically listen for next turn
        if (convActiveRef.current) {
          await new Promise(r => setTimeout(r, 400));
          if (convActiveRef.current) {
            void startRecordingInner();
          }
        } else {
          setOrbState('idle');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Voice command failed';
      setErrorMsg(msg);
      setOrbState('error');
      setTimeout(() => setOrbState('idle'), 3000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPlanId, activeIntervention, onActionTriggered]);

  const processAudioRef = useRef(processAudio);
  useEffect(() => { processAudioRef.current = processAudio; }, [processAudio]);

  const stopRecording = useCallback(() => {
    if (stoppedRef.current) return;
    stopSilenceRef.current?.();
    stopSilenceRef.current = null;
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    stoppedRef.current = true;
    recorder.stop();
  }, []);

  const stopRecordingRef = useRef(stopRecording);
  useEffect(() => { stopRecordingRef.current = stopRecording; }, [stopRecording]);

  async function startRecordingInner(): Promise<void> {
    stoppedRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });
        void processAudioRef.current(blob, mimeType);
      };

      recorder.start(100);
      setOrbState('recording');

      // Silence detection only in conversation mode
      if (convActiveRef.current) {
        stopSilenceRef.current = createSilenceDetector(stream, () => {
          stopRecordingRef.current();
        });
      }
    } catch {
      setErrorMsg('Microphone access denied');
      setOrbState('error');
      setConvActive(false);
      setTimeout(() => setOrbState('idle'), 2000);
    }
  }

  // ── Push-to-talk handlers (non-conversation mode) ─────────────────────────

  const handlePointerDown = useCallback(() => {
    if (convMode) return; // conversation mode uses tap, not hold
    if (orbState === 'idle') { unlockAudio(); void startRecordingInner(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orbState, convMode]);

  const handlePointerUp = useCallback(() => {
    if (convMode) return;
    if (orbState === 'recording') stopRecording();
  }, [orbState, convMode, stopRecording]);

  // ── Tap handler for conversation mode ─────────────────────────────────────

  const handleTap = useCallback(() => {
    if (!convMode) return;
    if (orbState === 'recording') { stopRecording(); return; }
    if (orbState === 'idle' || orbState === 'plan_ready') { unlockAudio(); void startRecordingInner(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convMode, orbState, stopRecording]);

  // ── Start / end conversation ───────────────────────────────────────────────

  async function startConversation(): Promise<void> {
    unlockAudio(); // must happen in the click handler, before any async gap
    setTurns([]);
    setConvActive(true);
    setConvMode(true);
    await new Promise(r => setTimeout(r, 100));
    void startRecordingInner();
  }

  function endConversation(): void {
    stopSilenceRef.current?.();
    stopSilenceRef.current = null;
    if (mediaRecorderRef.current?.state !== 'inactive') {
      stoppedRef.current = true;
      mediaRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
    }
    setConvActive(false);
    setConvMode(false);
    setOrbState('idle');
  }

  // ── Plan confirm / cancel ─────────────────────────────────────────────────

  async function handleConfirm(): Promise<void> {
    if (!plan) return;
    setConfirmingPlan(true);
    try {
      const res = await fetch(`/api/confirm/${plan.planId}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onPlanConfirmed?.(plan.planId);
      setPlan(null);
      setPendingPlanId(null);
      if (convActiveRef.current) {
        setTurns(prev => [...prev, { role: 'kairos', text: 'Confirmed. Executing now.' }]);
        setOrbState('speaking');
        await speakText('Confirmed. Executing now.');
        await new Promise(r => setTimeout(r, 300));
        void startRecordingInner();
      } else {
        setOrbState('idle');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Confirm failed');
      setOrbState('error');
      setTimeout(() => { setPlan(null); setPendingPlanId(null); setOrbState('idle'); }, 2500);
    } finally {
      setConfirmingPlan(false);
    }
  }

  function handleCancel(): void {
    setPlan(null);
    setPendingPlanId(null);
    if (convActiveRef.current) {
      void (async () => {
        await new Promise(r => setTimeout(r, 300));
        void startRecordingInner();
      })();
    } else {
      setOrbState('idle');
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const showTranscript = turns.length > 0;
  const recentTurns    = turns.slice(-6);

  return (
    <div style={styles.wrapper}>

      {/* Conversation transcript */}
      {showTranscript && (
        <div style={styles.transcript}>
          {recentTurns.map((t, i) => (
            <div key={i} style={{
              ...styles.bubble,
              alignSelf: t.role === 'user' ? 'flex-end' : 'flex-start',
              background: t.role === 'user'
                ? 'rgba(99,102,241,0.18)'
                : 'rgba(0,191,255,0.10)',
              borderColor: t.role === 'user'
                ? 'rgba(99,102,241,0.30)'
                : 'rgba(0,191,255,0.20)',
            }}>
              <span style={{ ...styles.bubbleRole, color: t.role === 'user' ? '#818cf8' : 'var(--accent-cyan)' }}>
                {t.role === 'user' ? 'You' : 'Kairos'}
              </span>
              <span style={styles.bubbleText}>{t.text}</span>
            </div>
          ))}
          {orbState === 'recording' && (
            <div style={{ ...styles.bubble, alignSelf: 'flex-end', background: 'rgba(239,68,68,0.10)', borderColor: 'rgba(239,68,68,0.25)' }}>
              <span style={{ ...styles.bubbleRole, color: '#f87171' }}>You</span>
              <span style={{ ...styles.bubbleText, color: 'var(--ink-400)' }}>
                <WaveAnimation />
              </span>
            </div>
          )}
          {orbState === 'processing' && (
            <div style={{ ...styles.bubble, alignSelf: 'flex-start', background: 'rgba(0,191,255,0.06)', borderColor: 'rgba(0,191,255,0.15)' }}>
              <span style={{ ...styles.bubbleRole, color: 'var(--accent-cyan)' }}>Kairos</span>
              <span style={{ ...styles.bubbleText, color: 'var(--ink-350)' }}>thinking…</span>
            </div>
          )}
          {orbState === 'speaking' && (
            <div style={{ ...styles.bubble, alignSelf: 'flex-start', background: 'rgba(0,191,255,0.06)', borderColor: 'rgba(0,191,255,0.15)' }}>
              <span style={{ ...styles.bubbleRole, color: 'var(--accent-cyan)' }}>Kairos</span>
              <span style={{ ...styles.bubbleText, color: 'var(--ink-350)' }}><SpeakingDots /></span>
            </div>
          )}
        </div>
      )}

      {/* Plan card — stays visible while recording yes/no in conversation mode */}
      {plan && orbState !== 'processing' && (
        <PlanCard
          plan={plan}
          onConfirm={() => { void handleConfirm(); }}
          onCancel={handleCancel}
          confirming={confirmingPlan}
        />
      )}

      {/* Error */}
      {orbState === 'error' && (
        <div style={styles.errorMsg}>{errorMsg}</div>
      )}

      {/* Intervention hint */}
      {activeIntervention && orbState === 'idle' && !convMode && (
        <div style={styles.interventionHint}>
          Alert active — say "deny" to block or "authorize" to allow
        </div>
      )}

      {/* Orb — keyboard accessible (Marco) */}
      <div
        style={orbStyle(orbState, convMode)}
        onPointerDown={convMode ? undefined : handlePointerDown}
        onPointerUp={convMode ? undefined : handlePointerUp}
        onPointerLeave={convMode ? undefined : handlePointerUp}
        onClick={convMode ? handleTap : undefined}
        role="button"
        tabIndex={0}
        aria-label={convMode ? 'Tap to speak — press Enter or Space' : 'Hold to record voice command — press Space to record'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (convMode) handleTap();
            else if (orbState === 'idle') { unlockAudio(); void startRecordingInner(); }
            else if (orbState === 'recording') stopRecording();
          }
        }}
        onFocus={(e) => { (e.currentTarget as HTMLElement).style.outline = '2px solid var(--accent-cyan)'; (e.currentTarget as HTMLElement).style.outlineOffset = '2px'; }}
        onBlur={(e) => { (e.currentTarget as HTMLElement).style.outline = 'none'; }}
      >
        <OrbInner state={orbState} convMode={convMode} />
      </div>

      {/* Controls row */}
      <div style={styles.controls}>
        {!convMode ? (
          <>
            <span style={styles.hint}>
              {orbState === 'idle'       ? 'Hold to speak' :
               orbState === 'recording'  ? 'Release to send' :
               orbState === 'processing' ? 'Processing…' : ''}
            </span>
            <button style={styles.convBtn} onClick={() => { void startConversation(); }}>
              💬 Chat Mode
            </button>
          </>
        ) : (
          <>
            <span style={styles.hint}>
              {orbState === 'idle'       ? (convActive ? 'Tap to speak' : '') :
               orbState === 'recording'  ? (plan ? 'Say yes or no… (tap to stop)' : 'Listening… (tap to stop)') :
               orbState === 'processing' ? 'Processing…' :
               orbState === 'speaking'   ? 'Speaking…' :
               orbState === 'plan_ready' ? 'Tap orb to respond by voice' : ''}
            </span>
            <button style={styles.endBtn} onClick={endConversation}>
              ✕ End
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Visual sub-components ────────────────────────────────────────────────────

function WaveAnimation(): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', height: '12px' }}>
      {[0,1,2,3].map(i => (
        <span key={i} style={{
          display: 'inline-block', width: '3px', borderRadius: '2px',
          background: '#f87171', opacity: 0.8,
          animation: 'voiceWave 0.8s ease-in-out infinite',
          animationDelay: `${i * 0.15}s`,
          height: '100%',
          transformOrigin: 'bottom',
        }} />
      ))}
    </span>
  );
}

function SpeakingDots(): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      {[0,1,2].map(i => (
        <span key={i} style={{
          display: 'inline-block', width: '5px', height: '5px', borderRadius: '50%',
          background: 'var(--accent-cyan)',
          animation: 'speakBounce 1s ease-in-out infinite',
          animationDelay: `${i * 0.2}s`,
        }} />
      ))}
    </span>
  );
}

function OrbInner({ state, convMode }: { state: OrbState; convMode: boolean }): React.JSX.Element {
  if (state === 'recording') {
    return (
      <div style={innerStyles.recordingRings}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ ...innerStyles.ring, animationDelay: `${i * 200}ms` }} />
        ))}
        <div style={innerStyles.micDot} />
      </div>
    );
  }
  if (state === 'processing') return <div style={innerStyles.spinner} />;
  if (state === 'speaking')   return <SpeakOrbInner />;
  if (state === 'plan_ready') return <div style={innerStyles.checkmark}>✓</div>;
  if (state === 'error')      return <div style={innerStyles.errorIcon}>✕</div>;
  return <div style={innerStyles.micIcon}>{convMode ? '💬' : '🎙'}</div>;
}

function SpeakOrbInner(): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
      {[0,1,2,3,4].map(i => (
        <div key={i} style={{
          width: '4px', borderRadius: '3px', background: 'white', opacity: 0.9,
          animation: 'speakWave 0.9s ease-in-out infinite',
          animationDelay: `${i * 0.1}s`,
          height: `${10 + i % 3 * 8}px`,
        }} />
      ))}
    </div>
  );
}

// ─── Plan card ────────────────────────────────────────────────────────────────

function PlanCard({ plan, onConfirm, onCancel, confirming }: {
  plan: VoicePlan; onConfirm: () => void; onCancel: () => void; confirming: boolean;
}): React.JSX.Element {
  return (
    <div className="glass" style={cardStyles.card}>
      <div style={cardStyles.header}>
        <span style={cardStyles.title}>Plan Ready</span>
        {plan.transcript && <span style={cardStyles.transcript}>"{plan.transcript}"</span>}
      </div>
      <p style={cardStyles.narration}>{plan.narratedText}</p>
      {plan.steps.length > 0 && (
        <div style={cardStyles.steps}>
          {plan.steps.map((step, i) => (
            <div key={step.id} style={cardStyles.stepRow}>
              <span style={cardStyles.stepIndex}>{i + 1}</span>
              <div style={cardStyles.stepBody}>
                <span style={cardStyles.stepType}>{step.type}</span>
                <span style={cardStyles.stepDesc}>{step.description}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={cardStyles.hint}>Say <strong>"yes"</strong> to confirm or <strong>"no"</strong> to cancel</div>
      <div style={cardStyles.actions}>
        <button style={cardStyles.cancelBtn} onClick={onCancel} disabled={confirming}>Cancel</button>
        {plan.steps.length > 0 && (
          <button
            style={{ ...cardStyles.confirmBtn, opacity: confirming ? 0.6 : 1, cursor: confirming ? 'wait' : 'pointer' }}
            onClick={onConfirm}
            disabled={confirming}
          >
            {confirming ? 'Executing…' : 'Confirm & Execute'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Orb style ────────────────────────────────────────────────────────────────

function orbStyle(state: OrbState, convMode: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    width: 76, height: 76, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    userSelect: 'none', touchAction: 'none', position: 'relative',
    transition: 'transform 0.2s ease, box-shadow 0.3s ease',
    flexShrink: 0,
    cursor: state === 'idle' ? 'pointer' : (state === 'recording' && convMode ? 'pointer' : 'default'),
  };
  switch (state) {
    case 'idle':
      return {
        ...base,
        background: convMode
          ? 'radial-gradient(circle at 35% 35%, #34d399, #059669)'
          : 'radial-gradient(circle at 35% 35%, #818cf8, #6366f1)',
        boxShadow: convMode
          ? '0 0 24px rgba(52,211,153,0.55), 0 0 48px rgba(52,211,153,0.20)'
          : '0 0 24px rgba(99,102,241,0.5),  0 0 48px rgba(99,102,241,0.2)',
        animation: 'glowPulse 3s ease-in-out infinite',
      };
    case 'recording':
      return { ...base, background: 'radial-gradient(circle at 35% 35%, #f87171, #ef4444)', boxShadow: '0 0 32px rgba(239,68,68,0.65)', transform: 'scale(1.12)' };
    case 'processing':
      return { ...base, background: 'transparent', border: '3px solid rgba(99,102,241,0.5)', boxShadow: '0 0 20px rgba(99,102,241,0.4)' };
    case 'speaking':
      return { ...base, background: 'radial-gradient(circle at 35% 35%, #22d3ee, #0891b2)', boxShadow: '0 0 28px rgba(34,211,238,0.60)', transform: 'scale(1.05)', animation: 'speakPulse 1.2s ease-in-out infinite' };
    case 'plan_ready':
      return { ...base, background: 'radial-gradient(circle at 35% 35%, #4ade80, var(--hue-green))', boxShadow: '0 0 24px rgba(74,222,128,0.5)', transform: 'scale(0.92)' };
    case 'error':
      return { ...base, background: 'radial-gradient(circle at 35% 35%, #f87171, #dc2626)', boxShadow: '0 0 24px rgba(220,38,38,0.5)' };
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 12, paddingTop: 8, paddingBottom: 4, width: '100%',
  },
  transcript: {
    width: '100%', maxHeight: '220px', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: '8px',
    padding: '4px 0',
    scrollbarWidth: 'none',
  },
  bubble: {
    maxWidth: '88%', padding: '8px 12px', borderRadius: '12px',
    border: '1px solid transparent',
    display: 'flex', flexDirection: 'column', gap: '2px',
    animation: 'fadeSlideUp 0.25s ease both',
  },
  bubbleRole: {
    fontSize: '9px', fontWeight: 800, letterSpacing: '0.10em',
    textTransform: 'uppercase' as const,
  },
  bubbleText: {
    fontSize: '12px', lineHeight: 1.45, color: 'var(--ink-800)',
  },
  controls: {
    display: 'flex', alignItems: 'center', gap: '10px', width: '100%', justifyContent: 'center',
  },
  hint: {
    fontSize: '0.70rem', color: 'var(--ink-280)', letterSpacing: '0.06em', minWidth: '80px', textAlign: 'center' as const,
  },
  convBtn: {
    background: 'rgba(52,211,153,0.10)', border: '1px solid rgba(52,211,153,0.28)',
    borderRadius: '100px', padding: '5px 12px',
    color: '#34d399', fontSize: '11px', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.03em',
    transition: 'all 0.2s',
  },
  endBtn: {
    background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.30)',
    borderRadius: '100px', padding: '5px 14px',
    color: '#f87171', fontSize: '11px', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  errorMsg: {
    fontSize: '0.73rem', color: '#f87171', textAlign: 'center' as const,
    maxWidth: 260, animation: 'fadeSlideUp 0.3s ease both',
  },
  interventionHint: {
    fontSize: '0.70rem', color: 'var(--hue-amber)', textAlign: 'center' as const,
    maxWidth: 260, padding: '6px 10px', borderRadius: '8px',
    background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
  },
};

const innerStyles: Record<string, React.CSSProperties> = {
  micIcon:   { fontSize: '1.4rem', lineHeight: 1 },
  recordingRings: { position: 'relative', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: '100%', height: '100%', borderRadius: '50%', border: '2px solid var(--ink-700)', animation: 'pulse 1.2s ease-out infinite' },
  micDot: { width: 10, height: 10, borderRadius: '50%', background: 'white' },
  spinner: { width: 34, height: 34, borderRadius: '50%', border: '3px solid var(--ink-150)', borderTopColor: 'white', animation: 'spin 0.8s linear infinite' },
  checkmark: { fontSize: '1.7rem', color: 'white', fontWeight: 700 },
  errorIcon: { fontSize: '1.4rem', color: 'white', fontWeight: 700 },
};

const cardStyles: Record<string, React.CSSProperties> = {
  card:      { padding: '16px', width: '100%', display: 'flex', flexDirection: 'column', gap: 10, animation: 'fadeSlideUp 0.35s ease both' },
  header:    { display: 'flex', flexDirection: 'column', gap: 3 },
  title:     { fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase' as const, color: 'var(--accent-cyan)' },
  transcript:{ fontSize: '0.70rem', color: 'var(--ink-350)', fontStyle: 'italic' },
  narration: { fontSize: '0.85rem', lineHeight: 1.55, color: 'var(--ink-850)' },
  hint:      { fontSize: '0.70rem', color: 'var(--ink-280)', textAlign: 'center' as const },
  steps:     { display: 'flex', flexDirection: 'column' as const, gap: 5 },
  stepRow:   { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px', borderRadius: '8px', background: 'var(--ink-040)' },
  stepIndex: { width: 16, height: 16, borderRadius: '50%', background: '#6366f1', color: 'white', fontSize: '0.60rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  stepBody:  { display: 'flex', flexDirection: 'column' as const, gap: 1 },
  stepType:  { fontSize: '0.60rem', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--accent-cyan)', textTransform: 'uppercase' as const },
  stepDesc:  { fontSize: '0.72rem', color: 'var(--ink-600)' },
  noSteps:   { padding: '6px 0', textAlign: 'center' as const },
  actions:   { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 },
  cancelBtn: { padding: '7px 14px', borderRadius: '8px', border: '1px solid var(--ink-120)', background: 'transparent', color: 'var(--ink-450)', fontSize: '0.75rem', cursor: 'pointer' },
  confirmBtn:{ padding: '7px 16px', borderRadius: '8px', border: 'none', background: '#6366f1', color: 'white', fontSize: '0.75rem', fontWeight: 700 },
};
