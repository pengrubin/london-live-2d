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

import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config';

export interface Capabilities {
  readonly region: {
    readonly name: string;
    /** [lon, lat] — GeoJSON order, matching MapLibre's `center`. */
    readonly center: readonly [number, number];
    readonly zoom: number;
    /** [[west, south], [east, north]] — MapLibre's `maxBounds` shape. */
    readonly maxBounds: readonly [readonly [number, number], readonly [number, number]];
  };
  readonly layers: Readonly<Record<string, boolean>>;
}

export function buildCapabilities(config: AppConfig): Capabilities {
  const { region } = config;
  const hasTfl = config.tflAppKey !== undefined;
  return {
    region: {
      name: region.name,
      center: [region.centerLon, region.centerLat],
      zoom: region.zoom,
      maxBounds: [
        [region.viewBounds.minLon, region.viewBounds.minLat],
        [region.viewBounds.maxLon, region.viewBounds.maxLat],
      ],
    },
    layers: {
      // TfL Unified API — tube/DLR/Overground/Elizabeth line and friends.
      tube: hasTfl,
      lineStatus: hasTfl,
      stopArrivals: hasTfl,
      jamCams: hasTfl,
      roadDisruptions: hasTfl,
      bikePoints: hasTfl,
      // Independent feeds, each gated by its own credential or flag.
      buses: config.bodsApiKey !== undefined,
      nationalRail: config.darwinToken !== undefined,
      vessels: config.aisApiKey !== undefined,
      tideGauges: region.tideGauges,
      // Global upstreams, available to every region.
      aircraft: true,
      rainRadar: true,
    },
  };
}

/** GET /api/capabilities — no params, no secrets, safe to cache briefly. */
export function registerCapabilitiesRoute(app: FastifyInstance, config: AppConfig): void {
  const payload = buildCapabilities(config);
  app.get('/api/capabilities', () => payload);
}
