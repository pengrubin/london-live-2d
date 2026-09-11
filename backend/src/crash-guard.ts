// Survive the one upstream failure Node gives us no way to catch, and record
// enough at that moment to name the upstream that caused it.
//
// Every outbound call here uses the global `fetch`, which is undici. When a
// TLS socket ends while undici's HTTP parser still expects bytes, the parser
// fails an internal assertion:
//
//   AssertionError [ERR_ASSERTION]: false == true
//       at Parser.finish (node:internal/deps/undici/undici:…)
//       at TLSSocket.<anonymous> (node:internal/…)
//       at TLSSocket.emit (node:events:531:35)
//
// It is thrown from the socket's own 'end' handler, NOT from the promise the
// caller is awaiting. No try/catch around `await fetch(...)` can see it, and
// no .catch() on the promise will either. It arrives as an uncaughtException,
// and Node's default for that is to kill the process.
//
// On 2026-09-11 that is exactly what happened: a process that had been up for
// 146 hours with a flat heap died at 13:15, and kept dying every few minutes
// after, because one upstream had started closing connections mid-response.
// Nothing had been deployed since 09-05. Memory was never involved — heap was
// 221-265 MB throughout, against a 2,053 MB limit.
//
// The bug is nodejs/undici#5360, fixed in undici 8.4.1/8.6.0. Node 22 and 24
// both still ship the broken 6.x/7.x lines, so it cannot be upgraded away
// today. Reading undici 6.28.0 (the copy inside Node 22.23.2), the assertion
// is reachable only when the response was NOT keep-alive (`Connection: close`
// or HTTP/1.0) and its body was still unread when the peer closed. Every
// healthy upstream answers keep-alive, so the trigger is an error page from a
// proxy in front of one of them, on a day that upstream is having trouble.
//
// Three defences live here:
//   1. absorb this one error class and keep serving; anything else still
//      exits, because an unknown uncaught exception means unknown state.
//   2. track every outbound request so the survival log can list what was in
//      flight and what had just finished, with the Connection header that
//      decides whether undici could have reached the assertion at all.
//   3. `discardBody`, for call sites that give up on a non-2xx response:
//      cancelling the body removes the "unread" half of the precondition.

/** Counts assertions survived, so /health shows whether this is firing. */
let survived = 0;

/** How many undici parser assertions this process has absorbed. */
export function survivedUpstreamAssertions(): number {
  return survived;
}

/**
 * True only for the undici parser assertion described above.
 *
 * Deliberately narrow. `ERR_ASSERTION` alone is not enough — our own code
 * could assert one day — so the stack must also name undici. Both conditions
 * or we treat it as fatal.
 */
export function isUndiciParserAssertion(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as NodeJS.ErrnoException).code !== 'ERR_ASSERTION') return false;
  return (err.stack ?? '').includes('undici');
}

// ---------------------------------------------------------------- tracking

/** One outbound request as the tracker saw it. Never the query string. */
interface UpstreamCall {
  readonly host: string;
  readonly path: string;
  readonly startedAt: number;
}

/** A finished request: what came back, and whether the socket could persist. */
interface SettledCall extends UpstreamCall {
  readonly status: number | 'threw';
  /** The response's Connection header; `close` is what makes the bug reachable. */
  readonly connection: string | null;
  readonly ms: number;
}

/** Finished requests kept for the survival log; the culprit is usually the last. */
const RECENT_MAX = 8;

const inflight = new Map<number, UpstreamCall>();
const recent: SettledCall[] = [];
let nextId = 0;

/**
 * Host and path only. Several upstreams take the API key as a query
 * parameter, so the search string must never reach a log line.
 */
/** fetch's own parameter types, so this compiles against Node's globals, not the DOM's. */
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function describe(input: FetchInput): { host: string; path: string } {
  try {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    return { host: url.host, path: url.pathname.slice(0, 80) };
  } catch {
    return { host: '?', path: '?' };
  }
}

function settle(
  id: number,
  call: UpstreamCall,
  status: number | 'threw',
  connection: string | null,
  now: () => number,
): void {
  inflight.delete(id);
  recent.push({ ...call, status, connection, ms: now() - call.startedAt });
  if (recent.length > RECENT_MAX) recent.shift();
}

/** What the tracker knows right now, ages in ms; attached to the survival log. */
export function upstreamSnapshot(now: () => number = Date.now): {
  inflight: { host: string; path: string; ageMs: number }[];
  recent: { host: string; path: string; status: number | 'threw'; connection: string | null; ms: number; agoMs: number }[];
} {
  const t = now();
  return {
    inflight: [...inflight.values()].map((c) => ({ host: c.host, path: c.path, ageMs: t - c.startedAt })),
    recent: recent.map((c) => ({
      host: c.host,
      path: c.path,
      status: c.status,
      connection: c.connection,
      ms: c.ms,
      agoMs: t - c.startedAt - c.ms,
    })),
  };
}

/**
 * Wraps the global fetch once so every outbound call is tracked without
 * touching the ten call sites. The wrapper changes nothing about the request
 * or the response; it only records host, path, timing, status and the
 * Connection header around the real call.
 */
export function installUpstreamTracker(now: () => number = Date.now): void {
  const realFetch = globalThis.fetch;
  const tracked = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const id = nextId;
    nextId += 1;
    const call: UpstreamCall = { ...describe(input), startedAt: now() };
    inflight.set(id, call);
    try {
      const response = await realFetch(input, init);
      settle(id, call, response.status, response.headers.get('connection'), now);
      return response;
    } catch (err) {
      settle(id, call, 'threw', null, now);
      throw err;
    }
  };
  globalThis.fetch = tracked as typeof fetch;
}

/**
 * For a call site that is not going to read a response it received. Cancelling
 * the body tells undici to tear the request down, so the socket cannot later
 * end while the parser is paused on bytes nobody asked for. Safe on a body that
 * is null or already consumed.
 */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed or already closed: nothing left to discard.
  }
}

// ---------------------------------------------------------------- policy

/**
 * The uncaughtException policy, separated from `process.on` so it can be
 * tested without killing the test runner. `exit` is the escape hatch a test
 * substitutes; production passes the real one.
 */
export function handleUncaught(
  err: unknown,
  log: (payload: Record<string, unknown>, msg: string) => void,
  exit: (code: number) => void,
  now: () => number = Date.now,
): void {
  if (isUndiciParserAssertion(err)) {
    survived += 1;
    log(
      { err, survived, upstreams: upstreamSnapshot(now) },
      'survived an undici parser assertion from an upstream socket; still serving',
    );
    return;
  }
  log({ err }, 'uncaught exception, exiting');
  exit(1);
}

/** Installs the policy above for the life of the process. */
export function installCrashGuard(
  log: (payload: Record<string, unknown>, msg: string) => void,
): void {
  process.on('uncaughtException', (err: unknown) => {
    handleUncaught(err, log, (code) => process.exit(code));
  });
}
