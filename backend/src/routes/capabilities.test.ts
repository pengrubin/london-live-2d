import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCapabilitiesRoute } from './capabilities';
import { startDiversionDetector } from '../diversion-detector';
import type { AppConfig } from '../config';

// Only the fields buildCapabilities reads; everything credential-ish is unset
// so the busCoverage flag is the sole moving part under test.
const CONFIG = {
  region: {
    name: 'Testville',
    centerLon: -0.1,
    centerLat: 51.5,
    zoom: 11,
    viewBounds: { minLon: -0.65, minLat: 51.2, maxLon: 0.45, maxLat: 51.77 },
    tideGauges: false,
    pmtilesUrl: undefined,
  },
} as unknown as AppConfig;

describe('capabilities busCoverage flag', () => {
  let app: FastifyInstance;
  let busDataDir: string;

  const layers = async (): Promise<Record<string, boolean>> => {
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    return (res.json() as { layers: Record<string, boolean> }).layers;
  };

  beforeEach(async () => {
    busDataDir = await mkdtemp(join(tmpdir(), 'caps-test-'));
    app = Fastify();
    registerCapabilitiesRoute(app, CONFIG, join(busDataDir, 'no-baked-data'), busDataDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(busDataDir, { recursive: true, force: true });
  });

  it('is false while no coverage artifact exists', async () => {
    expect((await layers()).busCoverage).toBe(false);
  });

  it('stays false when only the writer INPUTS exist — the toggle must never dead-click', async () => {
    // Inputs (learned routes + rollups) can precede the first artifact build
    // by hours; a flag keyed on inputs would render a toggle whose fetch 404s.
    await mkdir(join(busDataDir, 'bus-routes', 'learned'), { recursive: true });
    await writeFile(join(busDataDir, 'bus-routes', 'learned', 'TFLO_88_outbound.json'), '{}');
    await mkdir(join(busDataDir, 'bus-rollups'), { recursive: true });
    await writeFile(join(busDataDir, 'bus-rollups', '2026-08-27.json'), '{}');

    expect((await layers()).busCoverage).toBe(false);
  });

  it('flips true WITHOUT a restart once the coverage artifact lands', async () => {
    // The coverage writer produces its first artifact mid-process on a fresh
    // volume; a boot-frozen flag would hide the feature until a redeploy.
    expect((await layers()).busCoverage).toBe(false);

    await mkdir(join(busDataDir, 'coverage'), { recursive: true });
    await writeFile(join(busDataDir, 'coverage', 'latest.json'), '{"type":"FeatureCollection"}');

    expect((await layers()).busCoverage).toBe(true);
  });

  it('busDiversions flips true WITHOUT a restart once the detector starts', async () => {
    // Same bug class: on a fresh volume app.ts starts the detector from a
    // retry timer long after boot; the flag mirrors the running detector.
    expect((await layers()).busDiversions).toBe(false);

    const detector = startDiversionDetector(busDataDir, () => {});
    try {
      expect((await layers()).busDiversions).toBe(true);
    } finally {
      detector.stop();
    }
  });
});
