import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CORS_ORIGIN, DEFAULT_PORT } from './constants';

export interface AppConfig {
  readonly tflAppKey: string;
  readonly port: number;
  readonly corsOrigin: string;
  /** aisstream.io key for live vessel names; feature is off when absent. */
  readonly aisApiKey: string | undefined;
  /** National Rail Darwin OpenLDBWS token; NR boards are off when absent. */
  readonly darwinToken: string | undefined;
  /** BODS (data.bus-data.dft.gov.uk) key for live buses; feature is off when absent. */
  readonly bodsApiKey: string | undefined;
}

const ENV_FILE_PATH = fileURLToPath(new URL('../.env', import.meta.url));

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
  const tflAppKey = readEnv('TFL_APP_KEY');
  if (tflAppKey === undefined || tflAppKey === '') {
    throw new Error(
      'TFL_APP_KEY is not set. Add it to backend/.env (see backend/.env.example) ' +
        'or export it in the environment before starting the server.',
    );
  }

  const rawPort = readEnv('PORT');
  const port = rawPort === undefined ? DEFAULT_PORT : Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${rawPort}".`);
  }

  const corsOrigin = readEnv('CORS_ORIGIN') ?? DEFAULT_CORS_ORIGIN;
  const aisApiKey = readEnv('AIS_API_KEY');
  const darwinToken = readEnv('DARWIN_TOKEN');
  const bodsApiKey = readEnv('BODS_API_KEY');

  return { tflAppKey, port, corsOrigin, aisApiKey, darwinToken, bodsApiKey };
}
