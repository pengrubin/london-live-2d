import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AisClient } from './ais-client';

// Mimics the undici behaviour that crashed production (2026-08-22): calling
// close() on a socket that is still CONNECTING "fails the connection", which
// synchronously fires 'error' again. An error handler that responds to
// 'error' by closing therefore recurses until the stack overflows.
class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.CONNECTING;
  closeCalls = 0;

  constructor(_url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(_data: string): void {}

  close(): void {
    this.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CONNECTING) {
      this.dispatchEvent(new Event('error'));
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

const BBOX = { minLat: 51.3, minLon: -0.55, maxLat: 51.62, maxLon: 0.45 };

const instance = (i: number): FakeWebSocket => {
  const ws = FakeWebSocket.instances[i];
  if (!ws) throw new Error(`no FakeWebSocket instance ${i}`);
  return ws;
};

describe('AisClient error handling', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not close a CONNECTING socket on error (stack-overflow regression)', () => {
    const client = new AisClient('key', BBOX, () => {});
    client.start();

    const ws = instance(0);
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);

    // With the old handler this recursed FakeWebSocket.close ↔ 'error'
    // until RangeError: Maximum call stack size exceeded.
    ws.dispatchEvent(new Event('error'));

    expect(ws.closeCalls).toBe(0);
    client.stop();
  });

  it('still closes an OPEN socket on error', () => {
    const client = new AisClient('key', BBOX, () => {});
    client.start();

    const ws = instance(0);
    ws.readyState = FakeWebSocket.OPEN;
    ws.dispatchEvent(new Event('error'));

    expect(ws.closeCalls).toBe(1);
    client.stop();
  });

  it('reconnects after a failed connect via the close event', () => {
    vi.useFakeTimers();
    const client = new AisClient('key', BBOX, () => {});
    client.start();

    // A failed connect fires 'error' then 'close' on its own (WHATWG order).
    const ws = instance(0);
    ws.dispatchEvent(new Event('error'));
    ws.dispatchEvent(new Event('close'));

    vi.advanceTimersByTime(15_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    client.stop();
  });
});

// One AIS frame, enough to count as traffic for the idle watchdog.
const aisFrame = (): MessageEvent =>
  new MessageEvent('message', {
    data: JSON.stringify({ MetaData: { MMSI: 235_000_001, latitude: 51.5, longitude: -0.1 } }),
  });

const openSocket = (ws: FakeWebSocket): void => {
  ws.readyState = FakeWebSocket.OPEN;
  ws.dispatchEvent(new Event('open'));
};

const MINUTE = 60_000;
// IDLE_RECONNECT_MS (10 min) plus one watchdog tick (60 s) of detection slack.
const IDLE_DETECTED_MS = 11 * MINUTE;
const RECONNECT_DELAY_MS = 15_000;

describe('AisClient idle watchdog and generations', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('closes an OPEN socket that has been silent for 10 minutes and reconnects once', () => {
    const client = new AisClient('key', BBOX, () => {});
    client.start();
    const ws = instance(0);
    openSocket(ws);

    vi.advanceTimersByTime(IDLE_DETECTED_MS);
    expect(ws.closeCalls).toBe(1);

    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // The fake fires 'close' synchronously on close(); that must not have
    // scheduled a second reconnect on top of the watchdog's own.
    vi.advanceTimersByTime(RECONNECT_DELAY_MS * 4);
    expect(FakeWebSocket.instances).toHaveLength(2);
    client.stop();
  });

  it('never reconnects a socket that keeps receiving messages', () => {
    const client = new AisClient('key', BBOX, () => {});
    client.start();
    const ws = instance(0);
    openSocket(ws);

    for (let elapsed = 0; elapsed < 60 * MINUTE; elapsed += MINUTE) {
      ws.dispatchEvent(aisFrame());
      vi.advanceTimersByTime(MINUTE);
    }

    expect(ws.closeCalls).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.stop();
  });

  it('ignores a close event from a stale generation after a newer start()', () => {
    const client = new AisClient('key', BBOX, () => {});
    client.start();
    client.start();
    expect(FakeWebSocket.instances).toHaveLength(2);

    // The superseded socket finally closes; it must not schedule a reconnect
    // over the live one.
    instance(0).dispatchEvent(new Event('close'));
    vi.advanceTimersByTime(RECONNECT_DELAY_MS * 2);

    expect(FakeWebSocket.instances).toHaveLength(2);
    client.stop();
  });

  it('stop() cancels reconnects and the watchdog', () => {
    const client = new AisClient('key', BBOX, () => {});
    client.start();
    const ws = instance(0);
    openSocket(ws);

    client.stop();
    expect(ws.closeCalls).toBe(1);

    // A dead socket whose close handshake never completes still reads OPEN;
    // after stop() nothing may touch it or open a new one.
    ws.readyState = FakeWebSocket.OPEN;
    vi.advanceTimersByTime(60 * MINUTE);

    expect(ws.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
