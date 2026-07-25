// Self-scheduling for the bus-route learning pipeline — no OS cron needed.
//
// On startup: if the last successful learner run is older than STALE_AFTER_MS
// (or has never happened), run the pipeline after a short warm-up delay.
// Then repeat every RUN_INTERVAL_MS. Each cycle:
//   1. scripts/fetch-bus-prior.mjs   — only when priors are missing/stale (7 d)
//   2. scripts/learn-bus-routes.mjs  — always
// Both are spawned child node processes; their final summary line is logged.
// Failures are logged and retried at the next cycle — never fatal.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { persistPath } from './config';

const STALE_AFTER_MS = 20 * 60 * 60_000; // 20 h
const RUN_INTERVAL_MS = 24 * 60 * 60_000; // 24 h
const STARTUP_DELAY_MS = 60_000; // let the first polls land before learning
const PRIOR_MAX_AGE_MS = 7 * 24 * 60 * 60_000; // refresh priors weekly
const SCRIPT_TIMEOUT_MS = 45 * 60_000;

interface LastRunState {
  readonly ranAt?: number;
}

function lastRunAt(markerPath: string): number {
  try {
    const raw = readFileSync(markerPath, 'utf8');
    const state = JSON.parse(raw) as LastRunState;
    return typeof state.ranAt === 'number' ? state.ranAt : 0;
  } catch {
    return 0;
  }
}

/** Count learned route files (.json, excluding the dotfile marker). */
function learnedFileCount(learnedDir: string): number {
  try {
    return readdirSync(learnedDir).filter((n) => !n.startsWith('.') && n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function priorFreshEnough(priorDir: string): boolean {
  try {
    const stampPath = join(priorDir, '.fetched.json');
    if (!existsSync(stampPath)) return false;
    return Date.now() - statSync(stampPath).mtimeMs < PRIOR_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** Run one script, resolve with its last non-empty stdout line (the summary). */
function runScript(
  scriptPath: string,
  log: (msg: string) => void,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SCRIPT_TIMEOUT_MS,
      env,
    });
    let out = '';
    let errTail = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > 65_536) out = out.slice(-32_768);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errTail = (errTail + chunk.toString()).slice(-2_048);
    });
    child.on('error', (err) => {
      log(`learner pipeline: failed to spawn ${scriptPath}: ${String(err)}`);
      resolve();
    });
    child.on('close', (code) => {
      const lines = out.split('\n').filter((l) => l.trim() !== '');
      const summary = lines[lines.length - 1] ?? '(no output)';
      if (code === 0) {
        log(`learner pipeline: ${summary}`);
      } else {
        log(`learner pipeline: ${scriptPath} exited ${code}: ${summary} ${errTail.trim()}`);
      }
      resolve();
    });
  });
}

export class LearnerScheduler {
  private readonly scriptsDir: string;
  private readonly dataDir: string;
  private readonly log: (msg: string) => void;
  /** Resolved once so the scheduler's read and the spawned learner's write agree. */
  private readonly markerPath: string;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(scriptsDir: string, dataDir: string, log: (msg: string) => void) {
    this.scriptsDir = scriptsDir;
    this.dataDir = dataDir;
    this.log = log;
    // persistPath is robust (never throws) — safe to resolve at construction.
    this.markerPath = persistPath('bus-learner.last-run.json');
  }

  /** Env for spawned scripts: pins them to the SAME base dir + marker the writer
   *  and this scheduler use, so writer→learner→route all agree even under the
   *  volume→data/ fallback (BUS_DATA_DIR/BUS_LAST_RUN_PATH override the scripts'
   *  own PERSIST_DIR-derived defaults). */
  private scriptEnv(): NodeJS.ProcessEnv {
    return { ...process.env, BUS_DATA_DIR: this.dataDir, BUS_LAST_RUN_PATH: this.markerPath };
  }

  start(): void {
    // Freshness marker is runtime-written state: it rides on PERSIST_DIR in
    // production so the 20 h/24 h schedule survives redeploys (else the learner
    // would re-run on every boot). learn-bus-routes.mjs writes the matching
    // path (passed explicitly via BUS_LAST_RUN_PATH).
    //
    // Marker↔data fate guard: if a marker says "recently ran" but the learned
    // dir has zero files, the two lost sync (e.g. a redeploy wiped a data/-local
    // learned/ while a volume-backed marker survived). Treat that as "never ran"
    // so we re-learn once traces exist instead of idling for 20 h.
    const learnedDir = join(this.dataDir, 'bus-routes', 'learned');
    const ranAt = learnedFileCount(learnedDir) > 0 ? lastRunAt(this.markerPath) : 0;
    const age = Date.now() - ranAt;
    if (age > STALE_AFTER_MS) {
      this.log(
        `learner pipeline: last run ${age === Date.now() ? 'never' : `${Math.round(age / 3_600_000)} h ago`} — scheduling startup run`,
      );
      this.startTimer = setTimeout(() => void this.runCycle(), STARTUP_DELAY_MS);
      this.startTimer.unref();
    }
    this.cycleTimer = setInterval(() => void this.runCycle(), RUN_INTERVAL_MS);
    this.cycleTimer.unref();
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.cycleTimer) clearInterval(this.cycleTimer);
    this.startTimer = null;
    this.cycleTimer = null;
  }

  private async runCycle(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const env = this.scriptEnv();
      const priorDir = join(this.dataDir, 'bus-routes', 'prior');
      if (!priorFreshEnough(priorDir)) {
        await runScript(join(this.scriptsDir, 'fetch-bus-prior.mjs'), this.log, env);
      }
      await runScript(join(this.scriptsDir, 'learn-bus-routes.mjs'), this.log, env);
    } finally {
      this.running = false;
    }
  }
}
