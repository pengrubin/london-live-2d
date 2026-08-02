import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CORS_ORIGIN, DEFAULT_PORT } from './constants';
import { loadRegion, type RegionConfig } from './region';

export interface AppConfig {
  /**
   * TfL Unified API key. OPTIONAL: every TfL-derived layer (tube, arrivals,
   * line status, jam cams, road disruptions, bike points) is simply absent when
   * it is unset, the same way AIS/BODS/Darwin features already behave. That is
   * what lets a deployment outside London start at all.
   */
  readonly tflAppKey: string | undefined;
  readonly port: number;
  readonly corsOrigin: string;
  /** aisstream.io key for live vessel names; feature is off when absent. */
  readonly aisApiKey: string | undefined;
  /** National Rail Darwin OpenLDBWS token; NR boards are off when absent. */
  readonly darwinToken: string | undefined;
  /** BODS (data.bus-data.dft.gov.uk) key for live buses; feature is off when absent. */
  readonly bodsApiKey: string | undefined;
  /**
   * Directory for runtime-mutable state (leaderboard standings, learner marker).
   * Set in production to a mounted volume (e.g. Railway Volume at /data) so this
   * state survives redeploys; unset locally, where state stays under data/.
   */
  readonly persistDir: string | undefined;
  /** The geography this deployment serves — London unless REGION_* overrides it. */
  readonly region: RegionConfig;
}

const ENV_FILE_PATH = fileURLToPath(new URL('../.env', import.meta.url));

/** Repo data/ directory (sits beside backend/) — the fallback persist root. */
const DATA_DIR = fileURLToPath(new URL('../../data', import.meta.url));

/**
 * Legacy on-disk locations (relative to data/) for runtime-written files whose
 * path today differs from their flat PERSIST_DIR name. Keeps local (PERSIST_DIR
 * unset) behavior byte-identical to today while allowing a clean flat layout on
 * the volume. Files not listed here fall back to `data/<segments>` unchanged.
 */
const LEGACY_DATA_PATHS: Readonly<Record<string, string>> = {
  'bus-learner.last-run.json': 'bus-routes/learned/.last-run.json',
};

/** mkdir -p that reports success instead of throwing, for graceful fallback. */
function tryMkdir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Local (data/) absolute path for a logical state file, honoring LEGACY_DATA_PATHS. */
function localPath(logical: string): string {
  return join(DATA_DIR, ...(LEGACY_DATA_PATHS[logical] ?? logical).split('/'));
}

/**
 * Absolute path for a runtime-mutable state file. When PERSIST_DIR is set
 * (production → a mounted volume like /data) all such files live flat under it;
 * when unset each file falls back to the exact location it uses today under
 * data/. The parent directory is created (recursive) so first writes never fail.
 *
 * ROBUST FALLBACK: if the parent can't be created (unwritable / missing volume),
 * degrade to the local data/ layout so writes still land, and — should that also
 * fail — return the primary path anyway and let the caller's write fail (every
 * runtime writer is wrapped to log-and-continue). This never throws, so a bad
 * volume can't crash the backend at startup or in a poll loop.
 *
 * NOTE: only runtime-WRITTEN state routes through here. Git-committed baked data
 * (branches / lines / stations / nr / manifest) is still read from data/ as-is.
 */
export function persistPath(...segments: string[]): string {
  const persistDir = readEnv('PERSIST_DIR');
  const logical = segments.join('/');
  const primary = persistDir ? join(persistDir, ...segments) : localPath(logical);
  if (tryMkdir(dirname(primary))) return primary;
  // Volume set but unwritable → fall back to the local data/ layout.
  if (persistDir) {
    const fallback = localPath(logical);
    if (tryMkdir(dirname(fallback))) return fallback;
  }
  return primary; // last resort — caller's write will fail and be logged
}

/** The configured runtime base dir: the volume when PERSIST_DIR is set, else data/. */
export function persistBaseDir(): string {
  return readEnv('PERSIST_DIR') ?? DATA_DIR;
}

/**
 * Resolve a *writable* base dir for runtime bus data (traces, learned routes,
 * priors), degrading volume → data/ → data/-anyway. The single coherent base
 * shared by the trace writer, the learner scripts, and the read route so the
 * writer always writes where the learner reads and the route serves.
 * Never throws; logs each degradation step.
 */
export function resolveBusDataDir(log: (msg: string) => void): string {
  const configured = persistBaseDir();
  const candidates = configured === DATA_DIR ? [DATA_DIR] : [configured, DATA_DIR];
  for (const dir of candidates) {
    if (tryMkdir(dir)) {
      if (dir !== configured) {
        log(`persist: base dir "${configured}" unwritable; using fallback "${dir}"`);
      }
      return dir;
    }
    log(`persist: base dir "${dir}" not writable — trying next fallback`);
  }
  log('persist: no writable base dir; bus-data writes will be skipped and logged');
  return DATA_DIR;
}

/** Minimal dotenv-style parser: KEY=value lines, `#` comments, optional quotes. */
function parseEnvFile(contents: string): ReadonlyMap<string, string> {
  const entries = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .flatMap((line): ReadonlyArray<readonly [string, string]> => {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex <= 0) return [];
      const key = line.slice(0, separatorIndex).trim();
      const rawValue = line.slice(separatorIndex + 1).trim();
      const value = rawValue.replace(/^(["'])(.*)\1$/, '$2');
      return [[key, value]];
    });
  return new Map(entries);
}

function readEnv(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  if (!existsSync(ENV_FILE_PATH)) return undefined;
  return parseEnvFile(readFileSync(ENV_FILE_PATH, 'utf8')).get(name);
}

/** Loads and validates configuration; throws with a clear message on failure. */
export function loadConfig(): AppConfig {
  // Absent rather than fatal: a deployment outside London has no TfL key and
  // must still start, serving only the layers it does have. The startup log
  // reports the resulting layer set, so a key missing by accident is visible.
  const rawTflAppKey = readEnv('TFL_APP_KEY');
  const tflAppKey = rawTflAppKey === '' ? undefined : rawTflAppKey;

  const rawPort = readEnv('PORT');
  const port = rawPort === undefined ? DEFAULT_PORT : Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${rawPort}".`);
  }

  const corsOrigin = readEnv('CORS_ORIGIN') ?? DEFAULT_CORS_ORIGIN;
  const aisApiKey = readEnv('AIS_API_KEY');
  const darwinToken = readEnv('DARWIN_TOKEN');
  const bodsApiKey = readEnv('BODS_API_KEY');
  const persistDir = readEnv('PERSIST_DIR');
  const region = loadRegion(readEnv);

  return { tflAppKey, port, corsOrigin, aisApiKey, darwinToken, bodsApiKey, persistDir, region };
}
