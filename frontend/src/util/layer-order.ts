// Stacking helper for layers that want to sit beneath another one.
//
// MapLibre's addLayer THROWS when the `beforeId` names a layer that does not
// exist. Every "sit under the station dots / under the trains" insertion was
// written when those layers were guaranteed, which stopped being true once a
// deployment could lack the feeds that create them: a region with ships but no
// tube has no `trains-dots`, so the ship layer took itself down on startup.
//
// Passing `undefined` is the documented "add on top" behaviour, which is the
// right degradation — the layer this one wanted to hide under isn't there.

import type { Map as MaplibreMap } from 'maplibre-gl';

/** `layerId` if the map has it, else undefined (meaning "add on top"). */
export function below(map: MaplibreMap, layerId: string): string | undefined {
  return map.getLayer(layerId) ? layerId : undefined;
}
