export type WsMessageHandler = (msg: any) => void;

const PERMANENT_CLOSE_CODES = new Set([1008, 4001, 4003, 4008]);
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 10_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Map<string, WsMessageHandler[]> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private reconnectAttempt = 0;

  constructor(path: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${protocol}//${window.location.host}${path}`;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.emit('open', {});
      // Subscribe to log stream
      this.send({ type: 'subscribe' });
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.emit(msg.type, msg);

        if (msg.type === 'ping') {
          this.send({ type: 'pong' });
        }
      } catch {
        // Ignore parse errors
      }
    };

    this.ws.onclose = (event) => {
      this.ws = null;

      const permanent = PERMANENT_CLOSE_CODES.has(event.code);
      const reconnecting = this.shouldReconnect && !permanent;

      this.emit('close', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        permanent,
        reconnecting,
      });

      if (reconnecting) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event) => {
      this.emit('error', { message: 'WebSocket transport error', event });
    };
  }

  disconnect() {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.ws?.close(1000, 'Client disconnect');
    this.ws = null;
  }

  send(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  on(type: string, handler: WsMessageHandler) {
    const handlers = this.handlers.get(type) || [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }

  off(type: string, handler: WsMessageHandler) {
    const handlers = this.handlers.get(type) || [];
    this.handlers.set(type, handlers.filter((h) => h !== handler));
  }

  private emit(type: string, data: unknown) {
    const handlers = this.handlers.get(type) || [];
    handlers.forEach((h) => h(data));
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect() {
    this.clearReconnectTimer();

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt,
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) {
        return;
      }
      this.connect();
    }, delay);
  }
}
