// What this deployment can actually serve — geography plus the live layer set.
//
// The frontend reads this once at startup instead of assuming London: it centres
// the map where the backend says, and creates only the layers reported present.
// Without it, a deployment lacking (say) a TfL key would still render tube and
// bus toggles that answer 503 forever.
//
// Availability is derived from configuration alone — a key that is set, a flag
// that is on — never from a city name. Adding a region therefore never means
// touching this file.

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config';

/** The coverage flag means "GET /api/coverage will answer 200 right now", so
 * it watches the ARTIFACT file, not the writer's inputs — anything else opens
 * a window where the toggle renders but the fetch 404s. */
function coverageArtifactPath(busDataDir: string): string {
  return join(busDataDir, 'coverage', 'latest.json');
}

export interface Capabilities {
  readonly region: {
    readonly name: string;
    /** [lon, lat] — GeoJSON order, matching MapLibre's `center`. */
    readonly center: readonly [number, number];
    readonly zoom: number;
    /** [[west, south], [east, north]] — MapLibre's `maxBounds` shape. */
    readonly maxBounds: readonly [readonly [number, number], readonly [number, number]];
    /** Basemap for this region; omitted leaves the frontend on its default. */
    readonly pmtilesUrl?: string;
  };
  readonly layers: Readonly<Record<string, boolean>>;
}

export function buildCapabilities(
  config: AppConfig,
  bakedDataDir: string,
  busDataDir: string,
): Capabilities {
  const { region } = config;
  const hasTfl = config.tflAppKey !== undefined;

  // The coverage flow-map is derived offline from learned route polylines and
  // daily rollups. No credential is involved: a deployment that lost its BODS
  // key can still draw the map it already earned. True only once the writer
  // has actually produced a servable artifact.
  const hasBusCoverage = existsSync(coverageArtifactPath(busDataDir));

  // Line geometry and station points come from baked data on disk, NOT from a
  // credential — a region can have a drawn network with no operator API at all
  // (Dubai's comes from OpenStreetMap). Conflating the two was wrong: it made
  // "can I draw the network" depend on holding one particular company's key.
  const hasTransitLines = existsSync(join(bakedDataDir, 'manifest.json'));

  // Live train dots are the part that genuinely needs the operator feed. Kept a
  // strict subset of transitLines so a deployment can never render moving
  // vehicles with no track beneath them.
  const hasTrainPositions = hasTfl && hasTransitLines;

  return {
    region: {
      name: region.name,
      center: [region.centerLon, region.centerLat],
      zoom: region.zoom,
      maxBounds: [
        [region.viewBounds.minLon, region.viewBounds.minLat],
        [region.viewBounds.maxLon, region.viewBounds.maxLat],
      ],
      ...(region.pmtilesUrl === undefined ? {} : { pmtilesUrl: region.pmtilesUrl }),
    },
    layers: {
      // Static network geometry — baked data, no credential required.
      transitLines: hasTransitLines,
      // Live vehicle dots inferred from operator arrival predictions.
      trainPositions: hasTrainPositions,
      // TfL Unified API extras.
      lineStatus: hasTfl,
      stopArrivals: hasTfl,
      jamCams: hasTfl,
      roadDisruptions: hasTfl,
      bikePoints: hasTfl,
      // Independent feeds, each gated by its own credential or flag.
      buses: config.bodsApiKey !== undefined,
      busCoverage: hasBusCoverage,
      nationalRail: config.darwinToken !== undefined,
      bikeStations: config.gbfsUrl !== undefined,
      vessels: config.aisApiKey !== undefined,
      tideGauges: region.tideGauges,
      // Global upstreams, available to every region.
      aircraft: true,
      rainRadar: true,
    },
  };
}

/** GET /api/capabilities — no params, no secrets, safe to cache briefly. */
export function registerCapabilitiesRoute(
  app: FastifyInstance,
  config: AppConfig,
  bakedDataDir: string,
  busDataDir: string,
): void {
  let payload = buildCapabilities(config, bakedDataDir, busDataDir);
  app.get('/api/capabilities', async () => {
    // busCoverage is the one flag derived from a runtime-WRITTEN file rather
    // than config or baked data: on a fresh volume it is false at boot and
    // flips days later within this same process, when the coverage writer's
    // first artifact lands. Re-check per request until it flips (the artifact
    // is never deleted), then stop paying the stat. Async so the pre-flip
    // window never blocks the event loop — every other flag stays a boot-time
    // constant.
    if (!payload.layers.busCoverage) {
      const servable = await stat(coverageArtifactPath(busDataDir)).then(
        (s) => s.isFile(),
        () => false,
      );
      if (servable) {
        payload = { ...payload, layers: { ...payload.layers, busCoverage: true } };
      }
    }
    return payload;
  });
}
