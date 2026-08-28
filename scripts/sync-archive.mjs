#!/usr/bin/env node
// Pulls the day-partitioned runtime datasets (bus GPS traces, daily rollups,
// tube line-status) from a deployment's /api/export endpoints into a local
// archive directory. The server keeps raw traces only ~3 days (2 GB cap), so
// running this daily is what turns the rolling window into a permanent local
// archive that models can be trained on.
//
//   node scripts/sync-archive.mjs --dest ~/bus-archive
//     [--base https://london.pengrubin.com]   export endpoint origin
//     [--env-file path/to/.env]               where ADMIN_EXPORT_TOKEN lives
//     [--include-today]                       also pull today's growing files
//
// Zero dependencies (Node >= 18). Idempotent: a day file that already exists
// locally is never re-downloaded or overwritten; downloads land in a .part
// file and are renamed only on success, so a killed run leaves no torn files.
// Today's files are skipped by default because they are still being appended
// to on the server — yesterday and older are complete and immutable.

import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATASETS = [
  { name: 'bus-traces', ext: '.jsonl' },
  { name: 'bus-rollups', ext: '.json' },
  { name: 'tube-status', ext: '.jsonl' },
  { name: 'road-disruptions', ext: '.jsonl' },
];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_BASE = 'https://london.pengrubin.com';
const DEFAULT_ENV_FILE = fileURLToPath(new URL('../backend/.env', import.meta.url));

function parseArgs(argv) {
  const args = { base: DEFAULT_BASE, envFile: DEFAULT_ENV_FILE, dest: null, includeToday: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dest') args.dest = argv[++i];
    else if (arg === '--base') args.base = argv[++i];
    else if (arg === '--env-file') args.envFile = argv[++i];
    else if (arg === '--include-today') args.includeToday = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.dest) throw new Error('--dest is required (e.g. --dest ~/bus-archive)');
  return args;
}

function readToken(envFile) {
  const fromEnv = process.env.ADMIN_EXPORT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(envFile)) {
    throw new Error(`no ADMIN_EXPORT_TOKEN in environment and no env file at ${envFile}`);
  }
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('ADMIN_EXPORT_TOKEN='));
  const token = line?.slice('ADMIN_EXPORT_TOKEN='.length).trim();
  if (!token) throw new Error(`ADMIN_EXPORT_TOKEN not found in ${envFile}`);
  return token;
}

async function fetchJson(url, token) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function downloadTo(url, token, filePath) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok || !res.body) throw new Error(`GET ${url} → ${res.status}`);
  const part = `${filePath}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    await rename(part, filePath);
  } catch (err) {
    await unlink(part).catch(() => {});
    throw err;
  }
  return (await stat(filePath)).size;
}

const today = new Date().toISOString().slice(0, 10);
const args = parseArgs(process.argv);
const token = readToken(args.envFile);

let downloaded = 0;
let skipped = 0;
let bytes = 0;
let failures = 0;

for (const { name, ext } of DATASETS) {
  const dir = join(args.dest, name);
  await mkdir(dir, { recursive: true });
  let days;
  try {
    days = await fetchJson(`${args.base}/api/export/${name}`, token);
  } catch (err) {
    console.error(`${name}: listing failed: ${String(err)}`);
    failures += 1;
    continue;
  }
  for (const day of days) {
    if (!DAY_RE.test(day)) continue;
    if (day >= today && !args.includeToday) continue; // still growing on the server
    const filePath = join(dir, `${day}${ext}`);
    if (existsSync(filePath)) {
      skipped += 1;
      continue;
    }
    try {
      const size = await downloadTo(`${args.base}/api/export/${name}/${day}`, token, filePath);
      bytes += size;
      downloaded += 1;
      console.log(`${name}/${day}${ext}: ${(size / 1e6).toFixed(1)} MB`);
    } catch (err) {
      console.error(`${name}/${day}: download failed: ${String(err)}`);
      failures += 1;
    }
  }
}

console.log(
  `done: ${downloaded} downloaded (${(bytes / 1e6).toFixed(1)} MB), ${skipped} already local, ${failures} failed`,
);
if (failures > 0) process.exit(1);
