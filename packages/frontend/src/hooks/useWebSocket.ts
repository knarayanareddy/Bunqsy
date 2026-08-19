import { useEffect, useRef, useState, useCallback } from 'react';
import type { WSMessage, BUNQSYScore, OracleVote, OracleVerdict, InterventionPayload, DreamBriefingPayload, ScoreDeltaExplainPayload } from '@bunqsy/shared';

export interface WSState {
  connected: boolean;
  score: BUNQSYScore | null;
  scoreDelta: ScoreDeltaExplainPayload | null;
  votes: OracleVote[];
  verdict: OracleVerdict | null;
  intervention: InterventionPayload | null;
  dreamBriefing: DreamBriefingPayload | null;
  lastTick: string | null;
}

const INITIAL_STATE: WSState = {
  connected: false,
  score: null,
  scoreDelta: null,
  votes: [],
  verdict: null,
  intervention: null,
  dreamBriefing: null,
  lastTick: null,
};

export function useWebSocket(): WSState {
  const [state, setState] = useState<WSState>(INITIAL_STATE);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef<number>(1000);

  const connect = useCallback(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelay.current = 1000;
      setState(s => ({ ...s, connected: true }));
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      let msg: WSMessage;
      try {
        const raw = JSON.parse(event.data) as { type?: unknown; payload?: unknown };
        if (!raw || typeof raw.type !== 'string') return;
        msg = raw as WSMessage;
      } catch {
        return;
      }

      setState(s => {
        switch (msg.type) {
          case 'score_update':
            return { ...s, score: msg.payload };
          case 'score_delta_explain':
            return { ...s, scoreDelta: msg.payload };
          case 'oracle_vote':
            // Reset vote list on new oracle cycle
            const isNewCycle = s.verdict !== null;
            return {
              ...s,
              votes: isNewCycle ? [msg.payload] : [...s.votes.slice(-5), msg.payload],
              verdict: null
            };
          case 'oracle_verdict':
            return { ...s, verdict: msg.payload };
          case 'intervention':
            return { ...s, intervention: msg.payload };
          case 'dream_complete':
            return { ...s, dreamBriefing: msg.payload };
          case 'tick':
            return { ...s, lastTick: msg.payload.timestamp };
          default:
            return s;
        }
      });
    };

    ws.onclose = () => {
      setState(s => ({ ...s, connected: false }));
      const delay = reconnectDelay.current;
      reconnectTimer.current = setTimeout(connect, delay);
      reconnectDelay.current = Math.min(delay * 2, 30000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return state;
}
