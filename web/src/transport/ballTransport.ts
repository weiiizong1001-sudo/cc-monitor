import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport } from './types.js';

type TransportState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * WebSocket transport for the cc-monitor web UI.
 *
 * The SPA is served by the same Fastify server that owns the WebSocket, so the
 * WS URL is derived from window.location.host by the transport factory.
 *
 * Includes automatic reconnection with exponential backoff and message queuing.
 */
export class BallTransport implements MessageTransport {
  private ws: WebSocket | null = null;
  private handlers: Array<(msg: ServerMessage) => void> = [];
  private readonly url: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private pendingMessages: ClientMessage[] = [];
  private stateHandlers: Array<(s: TransportState) => void> = [];

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.disposed) return;
    this.setState(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState('connected');
      console.log('[Ball] WebSocket connected');
      for (const msg of this.pendingMessages) {
        this.ws!.send(JSON.stringify(msg));
      }
      this.pendingMessages = [];
    };

    this.ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        for (const handler of this.handlers) handler(msg);
      } catch {
        // Malformed JSON — ignore.
      }
    };

    this.ws.onclose = () => {
      if (!this.disposed) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose follows; reconnect handled there.
    };
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.pendingMessages.push(message);
    }
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  onStateChange(handler: (s: TransportState) => void): () => void {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter((h) => h !== handler);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.handlers = [];
    this.pendingMessages = [];
    this.stateHandlers = [];
    this.setState('disconnected');
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts++;
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(s: TransportState): void {
    for (const h of this.stateHandlers) h(s);
  }
}
