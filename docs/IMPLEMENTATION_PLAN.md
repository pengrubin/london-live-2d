# Implementation Plan: London Live 2D Transport Map

> **Orchestrator notes (P0 as-built deltas):** the scaffold implemented in P0 uses
> **TypeScript** (not the `.js` names below), serves the basemap from
> **`data/london.pmtiles`** via Vite `publicDir: '../data'` (not `frontend/public/basemap/`),
> and the backend framework decided in `ARCHITECTURE.md` is **Fastify** (not Express).
> Where this plan and `ARCHITECTURE.md` conflict, `ARCHITECTURE.md` wins on structure;
> this plan wins on phase sequencing, budgets, and acceptance criteria.

## Overview

A 2D real-time visualization of all London public transport, inspired by "Zone One"
(london.jamespotter.dev) but rendered on a full-London 2D basemap. MapLibre GL JS renders
a self-hosted Protomaps basemap plus official-colored transit lines; a Node.js backend
proxies the TfL Unified API (key never reaching the browser) and later aggregates
all-London bus positions over WebSocket. Delivered in gated phases P0–P5, each ending
with in-browser user acceptance.

## Guiding Principles

- **Key isolation:** the TfL API key lives only in the backend. The frontend never calls TfL directly.
- **Pre-bake static geometry:** line routes and station lists rarely change; fetch once at build time into `data/`, ship as static JSON. Real-time endpoints are polled at runtime only for predictions/positions.
- **Pragmatic testing:** unit-test the pure position-inference logic (the highest-risk, hardest-to-eyeball code); everything visual is verified by manual browser acceptance per phase.
- **Budget-aware polling:** free registered key allows ~500 req/min. Every phase's polling design stays an order of magnitude under that with batching + caching.
- **Each phase is independently shippable and demoable** before the next begins.

---

## Phase P0 — Scaffold + Basemap

### Goal
A running Vite dev server showing a pannable/zoomable 2D Protomaps basemap of Greater
London, plus a stub backend with a health endpoint. No transit data yet.

### Tasks
1. **Repo + workspace scaffold** — directory tree, independent frontend/backend npm packages, `.gitignore` (node_modules, `.env`, `*.pmtiles`, `dist/`).
2. **Frontend Vite app** — vanilla Vite + TypeScript, full-viewport map div, `maplibre-gl` + `pmtiles` deps.
3. **MapLibre init + pmtiles protocol** — register `pmtiles://` protocol, dark Protomaps flavor, center `[-0.1276, 51.5072]`, bounds clamped to Greater London, constants centralized.
4. **Basemap acquisition** — `pmtiles extract https://build.protomaps.com/<build>.pmtiles data/london.pmtiles --bbox=-0.55,51.25,0.35,51.72` (gitignored; command documented in README).
5. **Backend stub** — health endpoint, CORS for the Vite origin, env-validated config (`TFL_APP_KEY`, `PORT`), `.env.example`.

### TfL API usage
None in P0. (Key registration happens now so it is ready for P1/P2.)

### Acceptance criteria
- [ ] `npm run dev` in `frontend/` serves a map; London basemap renders, pans, and zooms smoothly.
- [ ] Map is visually clamped to Greater London (no infinite grey world).
- [ ] `curl localhost:PORT/health` returns ok (backend stub lands with P2 if deferred).
- [ ] No TfL key present anywhere in `frontend/`.

---

## Phase P1 — Static Transit Lines

### Goal
All rail lines drawn in official colors as static overlays: 11 Tube lines, DLR, the
6 named Overground lines, and the Elizabeth line — geometry + stations pre-baked from
TfL into `data/`, rendered from static JSON with no runtime TfL calls.

### Tasks
1. **Line manifest** (`scripts/build-manifest`, `data/manifest.json`) — authoritative catalog `{ id, name, mode, color }`. Overground is now **6 separate line ids** (`liberty`, `lioness`, `mildmay`, `suffragette`, `weaver`, `windrush`) each with its own official color; Elizabeth line is `elizabeth`; DLR is `dlr`. Colors from TfL's official palette.
2. **Route-baking script** (`scripts/bake-routes`, `data/lines/<id>.json`, `data/stations/<id>.json`) — for each line call `/Line/{id}/Route/Sequence/{direction}`, parse `lineStrings` into GeoJSON FeatureCollections, `stopPointSequences` into station GeoJSON; tag features with `lineId`/`mode`/`color`; commit the JSON. **Coordinate quality here directly determines P2 accuracy.**
3. **Transit line layer** (`frontend/src/layers/transit-lines.ts`) — per-line GeoJSON source + line layer, official colors, zoom-dependent width; legend/toggle keyed off manifest. Shared-corridor lines need offset/ordering to stay distinguishable.
4. **Stations layer** (`frontend/src/layers/stations.ts`) — circle layer, interchange styling, labels at higher zoom, dedupe by `naptanId`.
5. **Data serving** — baked JSON is served statically from `data/` (already the Vite publicDir); no backend needed in P1.

### TfL budget
~19 lines × 1–2 directions ≈ **20–40 requests, once, at bake time**. Runtime: **0 req/min**.

### Risks
- Overground line-id churn (changed late 2024) — validate against live `/Line/Mode/overground/Route` at bake time.
- Geometry branch/merge artifacts feed forward into P2 — manual visual QA before sign-off.

### Acceptance criteria
- [ ] All Tube lines, DLR, all 6 Overground lines, and Elizabeth line appear in correct official colors.
- [ ] Lines follow real track geometry (matches real topology, not straight-line stubs).
- [ ] Stations render; interchanges distinct; labels appear on zoom-in.
- [ ] Line toggle/legend works.
- [ ] Zero TfL network calls at runtime (verify in browser network tab).

### Testing
- Unit: bake-routes coordinate-string parser (sample `lineStrings` payload → correct `[lng,lat]` arrays).
- Manual browser acceptance for rendering.

---

## Phase P2 — Real-Time Trains (highest-logic-risk phase)

### Goal
Live train dots moving along the baked line geometry, positions inferred from arrivals
predictions and smoothly interpolated between polls. This phase owns the project's
hardest pure logic and gets real unit-test coverage.

### Tasks
1. **Backend arrivals proxy** — `GET /api/arrivals?lines=...` → `/Line/{ids}/Arrivals` with server-side key; fetch wrapper (timeout, retry, error normalization); outbound rate limiter; short TTL cache (~5–10 s) so many clients share one upstream fetch.
2. **Position-inference module** (`positionInference`) — **PURE, UNIT TESTED.** Given a line's baked geometry + ordered stations and an arrivals array, produce `{ trainId, lineId, lngLat, headingStationId, progress }`. Edge cases (all mandatory):
   - **Missing `vehicleId`** → synthesize stable identity from `currentLocation` (+ line + destination).
   - **Cross-line ghost trains** on shared sub-surface stock (District/Circle/H&C/Metropolitan) → dedupe by physical identity.
   - **DLR** (no `vehicleId` and no `currentLocation`) → leading-edge dedup: collapse multi-stop predictions to a single leading position.
   - **Overground / Elizabeth timetable-only predictions** → filter beyond an ~8-minute horizon.
3. **Interpolator** — **PURE, UNIT TESTED.** Advance trains along polyline by arc length between polls; handle appear/disappear (fade); reconcile new targets without teleporting.
4. **Trains controller + rendering** — poll `/api/arrivals`, feed inference, drive interpolator on `requestAnimationFrame`, render as circle/symbol layer; hover tooltip (destination, next stop).
5. **Poll scheduler + budget config** — batch all line ids into as few `/Line/{ids}/Arrivals` calls as possible; ~10 s interval; constants centralized.
6. **Unit tests (Vitest)** — fixture-driven with captured real arrivals payloads:
   - synthesizes stable id from `currentLocation` when `vehicleId` missing
   - dedupes one physical sub-surface train appearing on District and Circle
   - collapses DLR multi-stop predictions to a single leading position
   - filters Elizabeth/Overground predictions beyond 8-minute horizon
   - places train at correct arc-length offset for a given `timeToStation`
   - interpolator: advances without exceeding target; no teleport when new target arrives

### TfL budget
All rail ids batched, backend-polled every ~10 s → **6–24 req/min**, shared across all
clients via cache. Well under 500/min.

### Risks
- **High:** identity/dedup correctness and smooth interpolation — both covered by unit tests.
- Payload shape varies by mode — fixtures must include all modes, including a live District/Circle overlap capture.

### Acceptance criteria
- [ ] Trains move along correct lines in correct directions, on the tracks.
- [ ] Motion smooth (no teleport/rubber-banding between polls).
- [ ] No duplicate trains for shared sub-surface stock; DLR trains appear once each.
- [ ] No stationary ghost schedule trains for Overground/Elizabeth beyond the horizon.
- [ ] All unit tests pass; each documented edge case has a corresponding passing test.
- [ ] Runtime TfL request rate observed < ~30 req/min.

---

## Phase P3 — All-London Buses

### Goal
~9,000 live bus positions rendered as GPU points via deck.gl, streamed from a backend
aggregation service over WebSocket as full position snapshots.

### ⚠ Key data-source decision (confirm with user before starting)
The TfL Unified API does **not** expose raw all-bus GPS positions — only per-line/per-stop
arrivals predictions. Inferring 9,000 positions by polling ~600+ bus routes would blow the
rate budget and be inaccurate. **Recommended source: the DfT Bus Open Data Service (BODS)
SIRI-VM feed**, which provides real GPS for all London buses in one stream (free account).
Plan assumes BODS for positions with TfL for enrichment.

### Tasks
1. **Bus data client** (`backend .../buses/bods-client`) — poll/stream BODS SIRI-VM, parse vehicle activity into `{ vehicleId, lineRef, lngLat, bearing, timestamp }`. **High risk:** volume, SIRI-VM XML parsing, feed reliability.
2. **Aggregator** — in-memory latest-position map per vehicle; expire stale (~60 s); snapshot cadence ~1–3 s; compact payloads.
3. **WebSocket server** — full snapshot on connect + periodic snapshots; backpressure, ping/pong, compression.
4. **Frontend WS client** — parse snapshots, auto-reconnect with backoff, degrade to REST polling.
5. **deck.gl bus layer** — `MapboxOverlay` + `ScatterplotLayer`/`IconLayer` with bearing; interpolate between snapshots (straight-line + bearing; buses have no baked geometry).

### Acceptance criteria
- [ ] ~9,000 buses render and move; smooth frame rate on a normal laptop.
- [ ] Positions update live; stale buses disappear.
- [ ] WebSocket reconnects cleanly after a drop.
- [ ] Backend memory/bandwidth bounded under sustained run (soak test).

### Testing
- Unit: aggregator staleness/expiry + snapshot compaction (pure).
- Load/soak: extended run watching memory and client FPS.

---

## Phase P4 — Optional Extras (pick per user interest)

| Feature | Frontend | Backend | Source | Risk |
|---|---|---|---|---|
| Aircraft over London | `layers/aircraft.ts` | proxy route | adsb.lol (free, no key) | Low — poll a London bbox |
| Thames boats | `layers/boats.ts` | reuse arrivals proxy | TfL river-bus lines Arrivals | Low — reuses P2 inference |
| TfL JamCams | `layers/jamcams.ts` | proxy | TfL `/Place/Type/JamCam` | Low — points + image popups |
| Station departure popups | `ui/station-popup.ts` | `/StopPoint/{id}/Arrivals` | TfL | Negligible budget (on-click) |

---

## Phase P5 — Deploy

1. **Repo hygiene + GitHub** — audit for secrets/large binaries before first push (**critical**); document basemap acquisition; push.
2. **Frontend → Cloudflare Pages** — production build, `VITE_BACKEND_URL`/WS URL via env; basemap in Pages assets or R2 (size-dependent; R2 has zero egress).
3. **Backend → Railway** — `TFL_APP_KEY`/`BODS_KEY` as platform secrets; CORS locked to the Pages origin; health check; verify WS support and connection limits.
4. **Config wiring + smoke** — point frontend at deployed HTTPS/WSS; end-to-end smoke of every enabled phase; inspect deployed bundle to verify no secret leaked.

### Acceptance criteria
- [ ] Public URL loads with lines (P1), trains (P2), buses (P3) working against the deployed backend.
- [ ] Keys exist only as platform secrets; nothing sensitive in repo or client bundle.
- [ ] WSS works in production; reconnect works.
- [ ] Rate-limit and bandwidth costs sustainable.

---

## Cross-Cutting Testing Strategy

| Layer | Approach | Coverage target |
|---|---|---|
| Position inference | Vitest unit tests, fixture-driven, every edge case | High — core project risk |
| Interpolation | Vitest unit tests (arc-length advance, no teleport, appear/disappear) | High |
| Route baking | Unit test the coordinate-string parser | Parser covered |
| Bus aggregator | Unit test staleness expiry + snapshot compaction | Core logic covered |
| Backend proxy/cache | Lightweight integration test (mock TfL) for key isolation + cache TTL | Smoke |
| All rendering | Manual browser acceptance per phase gate | Human sign-off |
| Deploy | Production smoke checklists | Per phase |

Rationale: this is a visualization project — pixel behavior is validated by eye, but the
invisible position math is not, so the testing budget concentrates on the pure
inference/interpolation/aggregation logic where bugs are silent and costly.

## Consolidated Risk Register

| Risk | Phase | Severity | Mitigation |
|---|---|---|---|
| pmtiles range-serving fails in dev/prod | P0/P5 | Medium | Verified locally (206 responses); on Pages document range support or move to R2 |
| Basemap file size vs. git | P0 | Medium | Gitignored + extract command in README |
| Overground 6-line id/color churn | P1 | Medium | Validate against live `/Line/Mode/overground/Route` at bake time |
| Baked geometry artifacts feed P2 inaccuracy | P1→P2 | High | Manual geometry QA before P1 sign-off |
| Train identity/dedup + ghost trains wrong | P2 | High | Pure module + exhaustive fixture unit tests |
| Interpolation teleport/rubber-band | P2 | High | Arc-length walking + no-teleport unit test + visual acceptance |
| TfL has no raw bus GPS → 9k inference infeasible | P3 | High | Use BODS SIRI-VM; confirm with user before P3 |
| 9k points × WS bandwidth/FPS | P3 | High | deck.gl GPU render + aggregator throttle + soak test |
| Secret/key leak on first push | P5 | Critical | Pre-push audit; secrets only as platform env |

## Overall Success Criteria

- [ ] P0: London basemap live; no key in frontend.
- [ ] P1: all rail lines + stations in official colors, on-geometry, zero runtime TfL calls.
- [ ] P2: smooth, correctly-identified live trains; all edge cases unit-tested; budget < ~30 req/min.
- [ ] P3: ~9k live buses at smooth FPS over WebSocket; bounded backend resources.
- [ ] P4: chosen extras working with live data.
- [ ] P5: public deployment with secrets isolated and all enabled phases functional.
- [ ] Every phase received explicit in-browser user acceptance before the next began.
