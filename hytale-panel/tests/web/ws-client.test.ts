import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient } from '../../packages/web/src/lib/ws-client';

interface MockCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: MockCloseEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn((code: number = 1000, reason = '') => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  });

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  triggerClose(code: number, reason = '', wasClean = false) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean });
  }

  triggerMessage(data: string) {
    this.onmessage?.({ data });
  }
}

describe('ws client reconnect policy', () => {
  beforeEach(() => {
    vi.useRealTimers();
    MockWebSocket.instances = [];

    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        host: 'panel.example.com',
      },
    });
    vi.stubGlobal('WebSocket', MockWebSocket as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('subscribes after socket open', () => {
    const client = new WsClient('/ws/console');

    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0].triggerOpen();

    expect(MockWebSocket.instances[0].send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe' }));
  });

  it('does not reconnect on permanent close codes (e.g. unauthorized)', async () => {
    vi.useFakeTimers();

    const client = new WsClient('/ws/console');
    const closeEvents: Array<Record<string, unknown>> = [];
    client.on('close', (evt) => closeEvents.push(evt));

    client.connect();
    MockWebSocket.instances[0].triggerOpen();
    MockWebSocket.instances[0].triggerClose(4001, 'Unauthorized', true);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(closeEvents[0]).toMatchObject({
      code: 4001,
      permanent: true,
      reconnecting: false,
    });
  });

  it('reconnects with backoff for transient transport closures', async () => {
    vi.useFakeTimers();

    const client = new WsClient('/ws/console');
    const closeEvents: Array<Record<string, unknown>> = [];
    client.on('close', (evt) => closeEvents.push(evt));

    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0].triggerClose(1006, '', false);
    expect(closeEvents[0]).toMatchObject({
      code: 1006,
      permanent: false,
      reconnecting: true,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(MockWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.instances[1].triggerClose(1006, '', false);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(MockWebSocket.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('cancels reconnect timers on explicit disconnect', async () => {
    vi.useFakeTimers();

    const client = new WsClient('/ws/console');

    client.connect();
    MockWebSocket.instances[0].triggerOpen();
    MockWebSocket.instances[0].triggerClose(1006, '', false);

    client.disconnect();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
