import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyWebSocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { WSMessage } from '@bunqsy/shared';
import { getLastScore } from '../state.js';

// ─── Client registry ──────────────────────────────────────────────────────────

const clients = new Set<WebSocket>();

/** One dashboard needs one socket; the cap stops a local loop exhausting fds. */
const MAX_CLIENTS = 20;

/**
 * Drop a client whose kernel buffer is this far behind. The daemon pushes on a
 * 30 s heartbeat plus every oracle vote; a suspended laptop or a deliberately
 * non-reading socket would otherwise grow this buffer without bound.
 */
const MAX_BUFFERED_BYTES = 1_048_576;

/**
 * Broadcast a WSMessage to every connected client.
 * Clients in any state other than OPEN are silently skipped.
 */
export function wsEmit(msg: WSMessage): void {
  const text = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState !== 1 /* OPEN */) continue;

    if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      clients.delete(client);
      try { client.terminate(); } catch { /* already gone */ }
      continue;
    }

    try {
      client.send(text);
    } catch {
      clients.delete(client);
    }
  }
}

/** Exposed for health/diagnostics. */
export function wsClientCount(): number {
  return clients.size;
}

// ─── Fastify plugin ───────────────────────────────────────────────────────────

export async function registerWsRoute(fastify: FastifyInstance): Promise<void> {
  await fastify.register(fastifyWebSocket, {
    options: {
      // Clients never send us anything; anything large is either a bug or an
      // attempt to allocate memory on our side.
      maxPayload: 4 * 1024,
    },
  });

  fastify.get(
    '/ws',
    { websocket: true },
    (connection: WebSocket & { socket?: WebSocket }, _req: FastifyRequest) => {
      // @fastify/websocket v11 passes the WebSocket directly, v10 passed a SocketStream with a .socket property
      const socket: WebSocket = connection.socket ?? connection;

      if (clients.size >= MAX_CLIENTS) {
        socket.close(1013, 'Too many connections');
        return;
      }

      clients.add(socket);

      // Liveness: a half-open socket (laptop lid closed, NAT timeout) otherwise
      // sits in the broadcast set forever.
      let alive = true;
      socket.on('pong', () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) {
          clients.delete(socket);
          try { socket.terminate(); } catch { /* already gone */ }
          clearInterval(heartbeat);
          return;
        }
        alive = false;
        try { socket.ping(); } catch { /* closing */ }
      }, 30_000);

      const cleanup = (): void => {
        clients.delete(socket);
        clearInterval(heartbeat);
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);

      // Push last known score immediately so new clients don't wait for next tick
      const lastScore = getLastScore();
      if (lastScore) {
        socket.send(JSON.stringify({ type: 'score_update', payload: lastScore } satisfies WSMessage));
      }

      // Acknowledge connection
      socket.send(JSON.stringify({
        type:    'tick',
        payload: { tickId: 'connect', timestamp: new Date().toISOString() },
      } satisfies WSMessage));
    },
  );
}
