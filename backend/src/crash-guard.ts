// Survive the one upstream failure Node gives us no way to catch.
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
// So: catch this one error class and keep serving. Anything else still exits,
// because an unknown uncaught exception means unknown state, and a fast crash
// with a clean restart beats a server running on wreckage.

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

/**
 * The uncaughtException policy, separated from `process.on` so it can be
 * tested without killing the test runner. `exit` is the escape hatch a test
 * substitutes; production passes the real one.
 */
export function handleUncaught(
  err: unknown,
  log: (payload: Record<string, unknown>, msg: string) => void,
  exit: (code: number) => void,
): void {
  if (isUndiciParserAssertion(err)) {
    survived += 1;
    log(
      { err, survived },
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
