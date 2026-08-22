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
