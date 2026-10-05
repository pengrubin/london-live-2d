import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEALTH_FIRST_SAMPLE_MS,
  HEALTH_HISTORY_KEEP_DAYS,
  HEALTH_HISTORY_SUBDIR,
  HEALTH_SAMPLE_MS,
  HealthRecorder,
} from './health-recorder';
import { buildHealthBody } from './routes/health';
import { MS_PER_DAY } from './shared/london-date';

const DAY_MS = Date.UTC(2026, 9, 5, 12, 0, 0);
const build = (): object => buildHealthBody(() => ({ cacheArrivals: 7 }));

describe('HealthRecorder', () => {
  let base: string;
  let dir: string;
  const logs: string[] = [];
  const log = (msg: string): void => void logs.push(msg);

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'health-history-'));
    dir = join(base, HEALTH_HISTORY_SUBDIR);
    logs.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(base, { recursive: true, force: true });
  });

  it('appends one line with the /health keys plus at into the UTC day file', async () => {
    const recorder = new HealthRecorder(base, build, log);

    await recorder.sample(DAY_MS);
    await recorder.sample(DAY_MS + HEALTH_SAMPLE_MS);

    const lines = (await readFile(join(dir, '2026-10-05.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(Object.keys(first)).toEqual(['at', 'status', 'uptimeS', 'components', 'memory']);
    expect(first.at).toBe(DAY_MS / 1000);
    expect(first.components).toEqual({ cacheArrivals: 7 });
    expect(Object.keys(first.memory)).toEqual(['rssMB', 'heapUsedMB', 'heapTotalMB', 'externalMB']);
  });

  it('starts a new file when the UTC day rolls over', async () => {
    const recorder = new HealthRecorder(base, build, log);

    await recorder.sample(Date.UTC(2026, 9, 5, 23, 58));
    await recorder.sample(Date.UTC(2026, 9, 6, 0, 3));

    expect((await readdir(dir)).sort()).toEqual(['2026-10-05.jsonl', '2026-10-06.jsonl']);
  });

  it('prunes day files older than the retention window on rollover, keeping the rest', async () => {
    await mkdir(dir, { recursive: true });
    const old = new Date(DAY_MS - (HEALTH_HISTORY_KEEP_DAYS + 1) * MS_PER_DAY).toISOString().slice(0, 10);
    const kept = new Date(DAY_MS - (HEALTH_HISTORY_KEEP_DAYS - 1) * MS_PER_DAY).toISOString().slice(0, 10);
    await writeFile(join(dir, `${old}.jsonl`), '{}\n');
    await writeFile(join(dir, `${kept}.jsonl`), '{}\n');
    await writeFile(join(dir, 'notes.txt'), 'not a day file');

    await new HealthRecorder(base, build, log).sample(DAY_MS);

    expect((await readdir(dir)).sort()).toEqual([`${kept}.jsonl`, '2026-10-05.jsonl', 'notes.txt'].sort());
  });

  it('logs and resolves instead of throwing when the write fails', async () => {
    await writeFile(join(base, HEALTH_HISTORY_SUBDIR), 'a file where the directory should be');
    const recorder = new HealthRecorder(base, build, log);

    await expect(recorder.sample(DAY_MS)).resolves.toBeUndefined();
    expect(logs.some((m) => m.startsWith('health-history: sample failed'))).toBe(true);
  });

  it('takes its first sample after the warm-up delay and none after stop', async () => {
    vi.useFakeTimers({ now: DAY_MS });
    const recorder = new HealthRecorder(base, build, log);
    const spy = vi.spyOn(recorder, 'sample').mockResolvedValue();

    recorder.start();
    vi.advanceTimersByTime(HEALTH_FIRST_SAMPLE_MS - 1);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HEALTH_SAMPLE_MS);
    expect(spy).toHaveBeenCalledTimes(2);

    recorder.stop();
    vi.advanceTimersByTime(HEALTH_SAMPLE_MS * 3);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
