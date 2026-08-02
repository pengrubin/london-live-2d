# Region configuration

*Added 2026-08-02. Backend half; the frontend still hard-codes its own copy of
the map geography — see [Not done yet](#not-done-yet).*

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

## Not done yet

**The frontend still hard-codes London.** `main.ts` holds `LONDON_CENTER`,
`LONDON_BOUNDS` and `INITIAL_ZOOM`, and builds its layer list unconditionally, so
today a non-London deployment would centre on London and show toggles for layers
its backend does not have. `/api/capabilities` exists to be consumed; nothing
consumes it yet.

**`M_PER_DEG_LON` is baked at London's latitude in five places** —
`backend/src/shared/geometry.ts`, `frontend/src/realtime/geometry.ts`,
`frontend/src/layers/vessels.ts`, `frontend/src/layers/aircraft.ts` and
`frontend/src/ui/vehicle-popup.ts` — as `111320 × cos(51.5°)`.

This one is not cosmetic. `vessels.ts` uses it to dead-reckon a ship between
fixes: `lon + (speed × dt × sin θ) / M_PER_DEG_LON`. At 25°N the true value is
about 100,700 m/° against London's 69,300, so dividing by the London constant
overstates each east–west step by roughly 45%. Ships would visibly outrun
themselves. The backend copy is safe only because it serves the tube inference,
which is off wherever there is no TfL key.

Whoever does the frontend half must make this a function of the region's
latitude — it is a prerequisite for the ship layer being correct anywhere else,
not a tidy-up.
