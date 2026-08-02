# Region configuration

*Added 2026-08-02. Backend and frontend.*

## Why

Two people asked, within one week, how to run this map over a different city.
That is a real repetition rather than a speculative one, so the geography stopped
being a set of constants scattered across the backend and became configuration.

The second reason is more selfish: "a London map" and "a live-transport platform
that currently runs a London deployment" are the same code, but not the same
thing to anyone reading the repository.

## The rule: declare capabilities, never identity

There is deliberately **no `REGION=london` switch**, and the word for any
particular city appears nowhere in the code.

A deployment declares **what it has** — a bounding box, a credential, a centre
point. The backend derives the rest:

```
BODS_API_KEY set?     → the bus layer exists
TFL_APP_KEY unset?    → tube, arrivals, line status, jam cams, road
                        disruptions and cycle docks simply are not there
AIS_API_KEY + bbox?   → ships, subscribed to that box
```

`GET /api/capabilities` then reports the resulting set, so the frontend can build
itself from what the backend actually serves.

Two things follow from this rule, and both are the point of it:

1. **Adding a region touches no code.** It is an environment, not a branch.
2. **Nothing leaks.** A public repository can hold the mechanism while a
   deployment's geography lives only in its own environment variables.

The alternative — a city enum — would have put every city's name in the source
and grown an `if` in every feed. This costs nothing extra and does neither.

## What was hard-coded before

| Where | Constant | Now |
|---|---|---|
| `bods-client.ts` | `LONDON_BBOX = '-0.55,51.25,0.35,51.72'` | `REGION_BBOX` |
| `ea-tides.ts` | `BBOX = {51.25…51.72, -0.55…0.35}` | `REGION_BBOX` |
| `routes/stop-arrivals.ts` | `LONDON_LAT/LON_MIN/MAX` | `REGION_BBOX` + 0.2° margin |
| `ais-client.ts` | `THAMES_BOUNDING_BOXES` | `AIS_BBOX` |
| `routes/external.ts` | `ADSB_LAT/LON/RADIUS_NM` | `ADSB_CENTER`, `ADSB_RADIUS_NM` |
| `config.ts` | `TFL_APP_KEY` **required, threw at startup** | optional |

Every variable defaults to the value that was previously compiled in, so a
deployment setting none of them is byte-for-byte unchanged. `region.test.ts`
asserts exactly that, constant by constant — it is the test that matters most
here, because the London deployment is live and must not notice this refactor.

See `backend/.env.example` for the full annotated list.

## Design decisions worth knowing

**Coordinates are `lon,lat` everywhere**, including boxes
(`minLon,minLat,maxLon,maxLat`). That is GeoJSON order, MapLibre's `center`
order, and the order BODS already used. aisstream and adsb.lol want latitude
first; both conversions happen at their own call sites, in one line each, rather
than letting two orders coexist in the configuration.

**A malformed value stops the server**, naming the variable. The alternative —
falling back to the default — hides the mistake behind an empty map, which is a
much worse afternoon than a refusal to boot.

**A missing TfL key yields 503, not `[]`.** An empty array is indistinguishable
from "nothing is running right now". A frontend that reads `/api/capabilities`
never calls a route it was told does not exist, so anything that *does* reach one
is a human debugging, and a human wants the reason.

**Three boxes, not one**, because they genuinely differ:

- `REGION_BBOX` — the land area the feeds cover.
- `AIS_BBOX` — wider, because ships are worth showing offshore.
- `REGION_VIEW_BOUNDS` — wider still, so panning never hits a wall at the data's
  edge.

Collapsing them would have meant either a cramped map or a needlessly large feed
subscription.

**Tide gauges have an explicit off switch** (`TIDE_GAUGES=off`) even though the
bbox filter would empty them out on its own. Filtering to nothing still makes the
Environment Agency call every five minutes; the flag skips it.

## Verifying a non-London configuration

Boot with no TfL key and somewhere else's geography:

```bash
cd backend
env -u TFL_APP_KEY \
  REGION_NAME=Testville \
  REGION_BBOX=54.85,24.75,55.65,25.45 \
  REGION_VIEW_BOUNDS=54.7,24.6,55.8,25.6 \
  REGION_CENTER=55.27,25.2 REGION_ZOOM=10 \
  ADSB_CENTER=55.36,25.25 ADSB_RADIUS_NM=40 \
  AIS_BBOX=54.5,24.4,55.9,25.8 \
  TIDE_GAUGES=off PORT=3999 \
  npx tsx src/server.ts
```

Expected: the server starts (it would previously have thrown on the missing key),
`/api/capabilities` reports `aircraft` and `rainRadar` only, every TfL route
answers 503 with `{"error":"TFL_APP_KEY not configured"}`, and `/api/aircraft`
returns real traffic over the configured point.

## The frontend half

`frontend/src/region.ts` fetches `/api/capabilities` once, before the map is
created, and exposes three things: the region geography, `hasLayer(name)`, and
`metersPerDegLon()`.

**Bootstrap became async**, because centre, zoom, bounds and basemap all arrive
from that fetch. Everything that used to run at module scope in `main.ts` now
runs inside `bootstrap()`. `loadCapabilities()` never rejects — on any failure
it logs and falls back to London with every layer assumed present. That keeps
the property the app had before: the map renders even when the API does not
answer. Assuming *more* than exists is the safe direction, because each layer
already fails independently; assuming less would silently hide working ones.

**Failure isolation.** Previously `addTransitOverlays` ran three bare `await`s
(line geometry, stations, trains) inside one `try`/`catch` before the
`Promise.allSettled` that starts everything else. A single 404 on
`/manifest.json` therefore took the ships, aircraft and rain radar down with it.
That was latent in London and certain anywhere without baked tube data — note
that the manifest is fetched *twice*, independently, by `transit-lines.ts` and
`trains-controller.ts`, so guarding one would not have been enough. Each group
now fails on its own.

**`below(map, layerId)`** (`util/layer-order.ts`) exists because MapLibre's
`addLayer` **throws** when its `beforeId` names a layer that is absent. Seven
insertions said "sit under the station dots" or "sit under the trains" — true
only where a TfL key creates those layers. A region with ships but no tube saw
`vessels-icons` take itself down on startup. The helper degrades to "add on
top", which is the honest answer when the layer you wanted to hide under is not
there.

**Panels follow capabilities.** The bus route filter tab is omitted without
buses — a working-looking "type a route number" box in a city that has none is
worse than no tab. The leaderboard shows only rankings the deployment can
populate and defaults to the first of them, rather than opening on a Trains tab
that can only ever read "No movement recorded yet". `ship` is gated on vessels
*or* tube, because that ranking covers both AIS ships and TfL river boats.

**`metersPerDegLon()` replaced the baked `111320 × cos(51.5°)`** in
`layers/vessels.ts`, `layers/aircraft.ts` and `ui/vehicle-popup.ts`. It is read
per call, never captured in a module-level `const` — a module constant is
evaluated at import time, before the region is known, and would silently pin
every consumer back to London. Hot loops lift it into a local at function entry.

Why those three: `vessels` and `aircraft` dead-reckon between fixes
(`lon + speed × dt × sin θ / M_PER_DEG_LON`), so at 25°N — where the true value
is ~100,700 m/° against London's 69,300 — every east–west step is overstated by
about 45% and the marker visibly outruns itself. `vehicle-popup` uses it to pick
the nearest AIS ship to a click, so a wrong scale shows the **wrong vessel's**
name and photo.

## Still latitude-baked, deliberately

`realtime/geometry.ts` and its manual copy `backend/src/shared/geometry.ts`,
`layers/buses.ts`, and five `scripts/*.mjs` bakers still use `cos(51.5°)`.

- The two `geometry.ts` copies serve the tube/NR inference, which cannot run
  without a TfL or Darwin credential — i.e. only in the UK.
- `buses.ts` converts degrees → metres and back again, so the round trip
  cancels for *position*; only its speed and variance constants would be
  mis-scaled, and buses only exist where BODS does. Changing it would alter
  live London behaviour for no benefit.
- The `scripts/` bakers must stay consistent with whatever consumes their
  output — `learn-bus-routes.mjs` bakes `quality.meanResidualM`, which
  `buses.ts` reads as a Kalman measurement noise. Changing one without the
  other would silently mis-scale the filter.

A second region that acquires a bus or rail feed will need all of these
converted **together**, not piecemeal.

## Known data-source limit

`aisstream.io` is a volunteer receiver network, and its coverage is not global.
Measured on 2026-08-02: the London box returned 8 vessels within 20 seconds,
while a box covering the entire Persian Gulf and Strait of Hormuz (48–60°E,
23–30.5°N) returned **zero in 90 seconds**. The code path is identical and
correct; there is simply no data there.

So "ships work anywhere" is false. Ships work where the network has receivers.
Aircraft (ADS-B) and rain radar are genuinely global; a region should be
expected to prove its AIS coverage before the ship layer is promised.
