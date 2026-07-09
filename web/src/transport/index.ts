import { BallTransport } from './ballTransport.js';

/**
 * Create the singleton transport. cc-monitor is served by the same Fastify
 * server that owns the WebSocket, so the WS URL is derived from the page URL:
 * http://10.0.0.1:3100/ → ws://10.0.0.1:3100/ws. Falls back to loopback for
 * non-browser (test) environments.
 *
 * Typed as BallTransport (not just MessageTransport) so consumers can subscribe
 * to connection-state changes via onStateChange.
 */
function createTransport(): BallTransport {
  let url: string;
  if (typeof window !== 'undefined' && window.location) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    url = `${proto}//${window.location.host}/ws`;
  } else {
    url = 'ws://127.0.0.1:3100/ws';
  }
  const t = new BallTransport(url);
  t.connect();
  return t;
}

export const transport: BallTransport = createTransport();
export type { MessageTransport } from './types.js';
