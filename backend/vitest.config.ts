import { defineConfig } from 'vitest/config';

/**
 * The suite runs with `--expose-gc`.
 *
 * `bods-client.test.ts` guards the cause of the 2026-09-04 out-of-memory crash
 * by parsing documents far larger than the fields taken from them and asserting
 * the heap did not keep them. Without `global.gc` that test cannot tell a
 * retained document from one V8 simply has not collected yet, so it skips —
 * and a regression test that silently skips is worse than none, because the
 * suite still reports green. Exposing gc here means it runs on `npm test`, in
 * every checkout, rather than behind a script someone has to remember.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--expose-gc'],
      },
    },
  },
});
