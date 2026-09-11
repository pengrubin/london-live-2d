import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  discardBody,
  handleUncaught,
  installUpstreamTracker,
  isUndiciParserAssertion,
  upstreamSnapshot,
} from './crash-guard';

const GUARD_PATH = fileURLToPath(new URL('./crash-guard.ts', import.meta.url));

/** The production error, shape for shape: async, ERR_ASSERTION, undici stack. */
function undiciAssertion(): Error {
  const err = new Error('false == true');
  (err as NodeJS.ErrnoException).code = 'ERR_ASSERTION';
  err.stack = [
    'AssertionError [ERR_ASSERTION]: false == true',
    '    at Parser.finish (node:internal/deps/undici/undici:6165:9)',
    '    at TLSSocket.<anonymous> (node:internal/deps/undici/undici:6499:36)',
    '    at TLSSocket.emit (node:events:531:35)',
    '    at endReadableNT (node:internal/streams/readable:1698:12)',
  ].join('\n');
  return err;
}

describe('isUndiciParserAssertion', () => {
  test('recognises the parser assertion that killed production', () => {
    expect(isUndiciParserAssertion(undiciAssertion())).toBe(true);
  });

  test('does not swallow an assertion raised by our own code', () => {
    // Arrange — same code, but nothing to do with undici. If this ever
    // returned true the guard would hide a real bug in this repo.
    const ours = new Error('expected 2 stops, got 0');
    (ours as NodeJS.ErrnoException).code = 'ERR_ASSERTION';
    ours.stack = 'AssertionError [ERR_ASSERTION]\n    at buildItem (/app/backend/src/disruptions/resolver.ts:88:5)';

    expect(isUndiciParserAssertion(ours)).toBe(false);
  });

  test('does not swallow ordinary upstream failures', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    (timeout as NodeJS.ErrnoException).code = 'ABORT_ERR';

    expect(isUndiciParserAssertion(timeout)).toBe(false);
    expect(isUndiciParserAssertion(new TypeError('fetch failed'))).toBe(false);
    expect(isUndiciParserAssertion('not an error')).toBe(false);
    expect(isUndiciParserAssertion(undefined)).toBe(false);
  });
});

describe('handleUncaught', () => {
  test('keeps the process alive for the parser assertion, and says so', () => {
    // Arrange
    const logged: { payload: Record<string, unknown>; msg: string }[] = [];
    const exits: number[] = [];

    // Act
    handleUncaught(undiciAssertion(), (payload, msg) => logged.push({ payload, msg }), (c) => exits.push(c));

    // Assert — no exit, the survival is on the record, and the record names
    // what the tracker knew (empty here, but the shape is what the log reads).
    expect(exits).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.msg).toContain('survived');
    expect(logged[0]?.payload.survived).toBeGreaterThan(0);
    expect(logged[0]?.payload.upstreams).toMatchObject({ inflight: expect.any(Array), recent: expect.any(Array) });
  });

  test('still exits non-zero for anything else', () => {
    const exits: number[] = [];

    handleUncaught(new Error('genuinely broken'), () => {}, (c) => exits.push(c));

    expect(exits).toEqual([1]);
  });
});

describe('installUpstreamTracker', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('records host, path, status and the Connection header, never the query string', async () => {
    // Arrange — a fake upstream answering the shape that makes the bug
    // reachable: an error page that closes the connection. Clock is manual so
    // durations are exact.
    let clock = 1_000;
    globalThis.fetch = (async () =>
      new Response('<html>502</html>', { status: 502, headers: { connection: 'close' } })) as typeof fetch;
    installUpstreamTracker(() => clock);

    // Act
    const pending = fetch('https://data.bus-data.dft.gov.uk/api/v1/datafeed/?boundingBox=1,2,3,4&api_key=SECRET');
    const during = upstreamSnapshot(() => clock);
    clock += 250;
    const response = await pending;
    const after = upstreamSnapshot(() => clock);

    // Assert — the response is untouched, the call was visible while in
    // flight, and the settled record carries what the log needs and nothing
    // that must not be logged.
    expect(response.status).toBe(502);
    expect(during.inflight).toContainEqual({ host: 'data.bus-data.dft.gov.uk', path: '/api/v1/datafeed/', ageMs: 0 });
    const settled = after.recent.at(-1);
    expect(settled).toMatchObject({
      host: 'data.bus-data.dft.gov.uk',
      path: '/api/v1/datafeed/',
      status: 502,
      connection: 'close',
      ms: 250,
    });
    expect(JSON.stringify(after)).not.toContain('SECRET');
    expect(JSON.stringify(after)).not.toContain('boundingBox');
  });

  test('records a fetch that threw, and rethrows it unchanged', async () => {
    const boom = new TypeError('fetch failed');
    globalThis.fetch = (async () => {
      throw boom;
    }) as typeof fetch;
    installUpstreamTracker(() => 0);

    await expect(fetch('https://api.tfl.gov.uk/Line/victoria/Arrivals')).rejects.toBe(boom);

    expect(upstreamSnapshot(() => 0).recent.at(-1)).toMatchObject({
      host: 'api.tfl.gov.uk',
      path: '/Line/victoria/Arrivals',
      status: 'threw',
      connection: null,
    });
    expect(upstreamSnapshot(() => 0).inflight).toEqual([]);
  });
});

describe('discardBody', () => {
  test('cancels an unread body so the socket is torn down rather than left paused', async () => {
    // Arrange
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        cancelled = true;
      },
    });

    // Act
    await discardBody(new Response(body, { status: 503 }));

    // Assert
    expect(cancelled).toBe(true);
  });

  test('is harmless on a response with no body or an already-consumed one', async () => {
    const empty = new Response(null, { status: 204 });
    const consumed = new Response('done', { status: 200 });
    await consumed.text();

    await expect(discardBody(empty)).resolves.toBeUndefined();
    await expect(discardBody(consumed)).resolves.toBeUndefined();
  });
});

/**
 * The unit tests above prove the policy. This one proves the wiring: a real
 * process, a real asynchronous throw, no try/catch anywhere. Run twice — with
 * the guard and without — so the test states what the fix is worth rather
 * than merely asserting the fixed behaviour.
 */
describe('installCrashGuard in a real process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crash-guard-'));

  const THROW = `
    setTimeout(() => {
      const err = new Error('false == true');
      err.code = 'ERR_ASSERTION';
      err.stack = 'AssertionError [ERR_ASSERTION]: false == true\\n    at Parser.finish (node:internal/deps/undici/undici:5540:16)';
      throw err;
    }, 10);
    setTimeout(() => { console.log('STILL-SERVING'); process.exit(0); }, 400);
  `;

  const run = (source: string): ReturnType<typeof spawnSync> => {
    const file = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, source, 'utf8');
    return spawnSync(process.execPath, ['--import', 'tsx', file], { encoding: 'utf8', timeout: 30_000 });
  };

  test('without the guard, one socket assertion kills the process', () => {
    const out = run(THROW);

    expect(out.status).not.toBe(0);
    expect(out.stdout).not.toContain('STILL-SERVING');
  });

  test('with the guard installed, the same assertion is survived', () => {
    const out = run(`
      const { installCrashGuard } = await import(${JSON.stringify(GUARD_PATH)});
      installCrashGuard(() => {});
      ${THROW}
    `);

    expect(out.stdout).toContain('STILL-SERVING');
    expect(out.status).toBe(0);
  });
});
