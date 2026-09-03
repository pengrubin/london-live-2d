# Disruption-notice attachment for London Live 2D — merged research findings

Repo: `/Users/hongweipeng/claude_running/london-live-2d` (read `CLAUDE.md` first; `docs/ARCHITECTURE.md` is aspirational, trust the code).

Feature under study: attach TfL / National Rail disruption notices ("No service between X and Y", "changes at X") to stations and track segments on the map, with NO LLM. Strategy: (1) structured API fields first (`affectedRoutes` / `affectedStops`, Darwin per-station messages), (2) deterministic gazetteer + template parser over baked station names, (3) fall back to line-level, never attach a wrong location. Priority: tube/DLR/Overground/Elizabeth/tram > bus > National Rail.

This note merges eight sub-reports: A1 (status chain), A2 (rail graph), A3 (bus side), A4 (National Rail), A5 (layer conventions), B1 (TfL live probe), B2 (corpus analysis), B3 (Darwin probe). Every number, path and example sentence below comes from one of them; where sub-reports disagree, both claims are kept with attribution. "unverified" marks claims no sub-report verified.

Sample/scratch artefacts referenced below:
- TfL probe samples + 9 node measurement scripts: `~/bus-archive/disruption-research/2026-09-02/wf1/tfl`
- Darwin probe samples: `~/bus-archive/disruption-research/2026-09-02/wf1/darwin`
- Corpus analysis: `~/bus-archive/disruption-research/2026-09-02/wf1/corpus/analyse-reasons.mjs` (ESM, zero deps) -> `report.md` + `results.json`; report at `~/bus-archive/disruption-research/2026-09-02/wf1/corpus/report.md`

---

## 1 Codebase touchpoints (file:line)

### 1.0 Branch caveat (A3) — read before trusting any line number

- The repo-root checked-out `main` (ab4913c) is **18 PRs behind `origin/main`** (3bd517b). The entire diversion-detector feature (`backend/src/diversion-detector.ts`, `diversion-events.ts`, `routes/diversions.ts`, `frontend/src/layers/diversions.ts`, `route-projection.ts`) exists ONLY on origin/main — verified `git show main:backend/src/diversion-detector.ts` -> "path does not exist"; `git merge-base --is-ancestor 193a31b main` -> NO, `--is-ancestor 193a31b origin/main` -> YES.
- The worktree `/Users/hongweipeng/claude_running/london-live-2d/.claude/worktrees/rollup-attribution` (branch `feat/archive-leaderboard-days`, fd13078) is byte-identical to origin/main (`git diff fd13078 3bd517b --stat` empty) and was used by A3 to read those files.
- Identical between local main and origin/main (`git diff --stat ab4913c 3bd517b -- <files>` empty): `backend/src/bods-client.ts`, `backend/src/routes/bus-routes.ts`, `backend/src/routes/stop-arrivals.ts`, `scripts/fetch-bus-prior.mjs`, `scripts/bake-routes.mjs`.
- Differ (508 lines of diff): `frontend/src/layers/buses.ts`, `frontend/src/ui/bus-filter.ts`, `scripts/learn-bus-routes.mjs` (349 diff lines for the last one alone).
- Sub-reports A1, A2, A4, A5, B1, B3 do not state which checkout they read; line numbers for `app.ts`, `tfl-client.ts`, `tube-status-recorder.ts` differ between sub-reports (see 1.9), consistent with — but not proven to be caused by (unverified) — this divergence.

### 1.1 Backend TfL status chain (A1, A2, B1)

| Symbol | Path:line | What it is |
|---|---|---|
| `fetchTfl` | `backend/src/tfl-client.ts:99-115` (A1) | Single low-level TfL fetch wrapper: `new URL(path, TFL_BASE_URL)`, optional `params` via `url.searchParams.set` (line 106), then `app_key` appended last (line 107). Arbitrary params already supported — `fetchBikePoints` (lines 86-97) passes a params object. |
| `fetchLineStatus` | `tfl-client.ts:39-45` (A1, B1) | `/Line/{ids}/Status`, no `detail`. Backs `/api/line-status`. |
| `fetchLineStatusByModes` | `tfl-client.ts:48-54` (A1) / `tfl-client.ts:53-60` with `withDetail` param (A2, B1) / `tfl-client.ts:55-61` (B1: "bypasses TtlCache/RateBudget") | Mode-form status. A1: "no params object at all" and "No existing caller passes detail=true". A2/B1: signature `fetchLineStatusByModes(modes, appKey, timeoutMs, withDetail)`, called with `withDetail=true` from `tube-status-recorder.ts`. See 1.9. |
| `fetchRoadDisruptions` | `tfl-client.ts:49-54` (A3) | `/Road/all/Disruption`. |
| lift disruptions | `tfl-client.ts:86` (B1) | `/Disruptions/Lifts/v2/`. |
| TfL endpoint inventory | `tfl-client.ts:12-103` (A3) | Exports only `fetchLineStatus` / `fetchLineStatusByModes` / `fetchRoadDisruptions` / `fetchStopDetail` (+ bike points, lifts): no bus-mode line status, no StopPoint disruption, no `affectedStops`/`affectedRoutes` fetcher. |
| `registerLineStatusRoute` | `backend/src/routes/stop-arrivals.ts:43-49` (A1, B1) / `:42-47` (A2) | GET `/api/line-status`, `singleParamKey('lines', LINE_IDS_PATTERN)`, uses `fetchLineStatus` WITHOUT detail. NAPTAN/line-id regex patterns at `stop-arrivals.ts:14-19`; `NAPTAN_ID_PATTERN` at line 15; `LINE_IDS_PATTERN` line 19; `singleParamKey` in `proxy-route.ts:52-60`. Lift route at `stop-arrivals.ts:70-73`. |
| `registerProxyRoute` | `backend/src/routes/proxy-route.ts:71-138` (A1) | Mandatory spec object for every upstream route: `spec.parseKey` (400 on invalid, lines 100-102); `cache.getFresh` first (`x-cache: hit`, lines 105-106); `budget.tryConsume()` gate, on exhaustion `cache.getStale` (`x-cache: stale`) or 429 (lines 108-114); on success the FULL body is cached and forwarded verbatim (`x-cache: miss`, lines 118-120); on non-200 the app_key is stripped from the JSON-stringified body (lines 122-125, `raw.replaceAll(appKey, '<redacted>')`) — redaction fires ONLY on non-200 paths. No `TFL_APP_KEY` -> route 503s permanently at registration (lines 84-90). |
| `registerRoadDisruptionsRoute` | `backend/src/routes/external.ts:117-127` (A1) / `:117-121` (B1) | Straight passthrough of `/Road/all/Disruption`; no server-side shaping. |
| `registerNrBoardRoute` | `external.ts:65-81` (A1, A4) / `:73-80` cache-set (B3) | GET `/api/nr-board?crs=XXX`, 503 when `DARWIN_TOKEN` unset, `CRS_PATTERN /^[A-Za-z]{3}$/`, shares cache+budget with the leaderboard sampler via `registerProxyRoute`. |
| Constants | `backend/src/constants.ts` | `TFL_BUDGET_LIMIT=60` (line 8), `TFL_BUDGET_WINDOW_MS=60_000` (line 11), `ARRIVALS_CACHE_TTL_MS=8_000` (line 2), `UPSTREAM_TIMEOUT_MS=8_000` (line 5, B3: "Timeout in code is 8000 ms"). |
| `app.ts` wiring | `backend/src/app.ts` | Egress rationale for brotli q4 compression: lines 78-99 (origin->CDN egress was 86% of the Railway bill; `/api/arrivals` ~7.4MB raw -> ~300KB gzipped, 24x). TTL constants lines 188-192 (`LINE_STATUS_TTL_MS=60_000` at 188; stop-detail 600s at 189; crowding 60s at 190; lift 300s at 191; bike 60s at 192). TtlCache/RateBudget instantiation and route registration 194-213; `lineStatusCache` 197; `registerLineStatusRoute` 209; shared `tflBudget` line 202 (A1) / line 249 (A3) `new RateBudget(TFL_BUDGET_LIMIT, TFL_BUDGET_WINDOW_MS)`. Leaderboard shares `arrivalsCache` 216-218 (comment), 246-252. `NR_BOARD_TTL_MS=45_000` + `nrBoardCache` 226-227; `darwinBudget = new RateBudget(40, 60_000)` 228; `nrSampler` construction 230-240, 237; `registerNrBoardRoute` 300-302. Jamcams 266,271; road-disruptions 292-298 (TTL 120s). Non-TfL budgets `adsbBudget`/`adsbdbBudget`/`eaBudget` at 267-268, 282. Baked data read via `DATA_DIR`/`resolveBakedDataDir()` at 53-72. A3 cites app.ts:206-207 for the comment calling the road-disruption feed "the gold standard for validating" the detector's geometry. |
| `TtlCache` / `RateBudget` | `backend/src/cache.ts`, `backend/src/rate-budget.ts` (`RateBudget(limit, windowMs)` at `rate-budget.ts:6-24`) | Generic TTL cache (`getFresh`/`getStale`/`set`) and sliding-window limiter. |
| capabilities | `backend/src/routes/capabilities.ts:31-79`, booleans at 57-77 (`lineStatus: hasTfl` at 63, `nationalRail: config.darwinToken !== undefined` at 70) | Where a new `disruptions` capability boolean must be added (config-derived only). |

Shared-TfL-budget consumer inventory (A1): (1) `/api/arrivals` polled every 10s by every browser (`frontend/src/realtime/trains-controller.ts:13,170`) against one shared cache key, 8s TTL -> effectively ONE upstream call per ~10s system-wide; (2) `LeaderboardTracker` tube sampler every 15s (`backend/src/leaderboard.ts:23 SAMPLE_INTERVAL_MS`) reusing the identical `arrivalsCache` key + `tflBudget` (~0 extra calls); (3) `/api/stop-arrivals` click-only (`station-popup.ts:303`), 8s TTL (app.ts:195); (4) `/api/vehicle-arrivals` click-only (`vehicle-popup.ts:139`), 8s TTL (app.ts:196); (5) `/api/line-status` click-only (`vehicle-popup.ts:141`), 60s TTL; (6) `/api/stop-detail` click-only (`station-popup.ts:228`), 600s; (7) `/api/crowding` click-only (`station-popup.ts:229`), 60s; (8) `/api/lift-disruptions` click-only (`station-popup.ts:230`), 300s; (9) `/api/bike-points` click-only (`station-popup.ts:231`), 60s; (10) `/api/jamcams` once at layer init (`frontend/src/layers/jamcams.ts:25`), 600s; (11) `/api/road-disruptions` polled every 120s (`frontend/src/layers/road-disruptions.ts:25 POLL_INTERVAL_MS`), 120s TTL; (12) `TubeStatusRecorder` every 2 min, OUTSIDE the budget entirely. Darwin (`/api/nr-board`, `NrSampler`) uses the SEPARATE `darwinBudget` (40/min) and `nrBoardCache` (45s).

### 1.2 Tube status recorder — the existing detail=true poll (A1, A2, B1, A5)

`backend/src/tube-status-recorder.ts`:
- `POLL_INTERVAL_MS = 2*60_000` (line 13); `STATUS_MODES` tube,overground,dlr,elizabeth-line,tram (line 16 per A2, line 17 per A1/B1); `SUBDIR` line 18.
- Calls `fetchLineStatusByModes` DIRECTLY — line 126 (A1) / `:256` with `true` -> `?detail=true` (B1) / `:253-256` (A2) — bypassing `registerProxyRoute`, `TtlCache`, `RateBudget` (~0.5 req/min).
- `compactStatus()` lines 51-73 (A1, A5): reduces to `{id, st:[{s,d,r?}]}` per line — severity, short description, reason only when non-empty (lines 56-66/56-68). B1 cites `compactStatus` at `:178` (sorts and compacts, change-detection dedup).
- `compactRoutes()` / `compactDisruption()` / `TflAffectedRoute` lines 100-169 (A2); `compactDisruption()` `:156-171` (B1) keeps category `c`, closureText `ct`, validityPeriods `v`, affectedRoutes `ar{id,n,dir,o,de,st[naptan ids]}` (`routeSectionNaptanEntrySequence` -> ordered NaPTAN id arrays) and affectedStops `as[naptan ids]` (deduplicated). Comment at `:225`: "disruption.affectedRoutes — the ground truth for \"which segments\" a reason sentence means"; comment at `:253-256`: "detail=true adds affectedRoutes/affectedStops: the ground truth that pairs each free-text reason with NaPTAN ids, which the disruption-geolocation parser is evaluated against. Without it the archive holds only prose."
- `shouldWrite()` lines 79-88 (writes on change, or every 30 min heartbeat); writes to `<busDataDir>/tube-status/YYYY-MM-DD.jsonl` (line 154; `join(baseDir, 'tube-status')` at line 103); `busDataDir` from `resolveBusDataDir()` in `config.ts` (PERSIST_DIR in prod, `data/` locally). Never pruned (comment lines 6-7). Exported via `backend/src/routes/data-export.ts:30` (B1).
- Test fixture `backend/src/tube-status-recorder.test.ts:9-19`: `reason: 'DISTRICT LINE: No service between Tower Hill and Barking due to a signal failure.'` — spec-by-example for the target template. `tube-status-recorder.test.ts:117` assumes "TfL repeats stops per platform" (B1: not observed in 113 stops).
- Local archive (A1/A2): `/Users/hongweipeng/claude_running/london-live-2d/.claude/worktrees/rollup-attribution/data/tube-status/*.jsonl` — worktree-local, uncommitted (`git ls-files data/tube-status` empty; no `data/tube-status` at repo root). B2's 10-day corpus came from the same recorder output (path not restated in B2).
- `backend/src/status-recorder.ts` (A3): `STATUS_MODES` (line 19) `['tube','overground','dlr','elizabeth-line','tram']` excludes `'bus'`; `ROAD_DISRUPTIONS_FEED` (lines 175-185, `pollMs=6*60*60_000`) archives `/Road/all/Disruption` every 6 h; `DisruptionSnapshot` compact schema (lines 92-108) `{id, cat, sev, loc, com, start, end, pt}` — free-text `loc`/`com` only, no structured route/stop ids.

### 1.3 Backend Darwin / National Rail chain (A4, B3, A2)

| Symbol | Path:line | Note |
|---|---|---|
| `RDM_BASE` | `backend/src/darwin-client.ts:6-7` | `https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120` |
| `fetchNrBoard()` | `darwin-client.ts:67-107` (A1) / `:70-116` (A4) / url `:75`, headers `:78` (B3) | `GetDepBoardWithDetails/{crs}?numRows=20&timeWindow=120`, header `x-apikey` + `accept: application/json`. Normalises to `NrBoard{crs, locationName, generatedAt, services:[...]}`. |
| `NrBoard`/`NrService`/`NrCallingPoint` | `darwin-client.ts:9-34` (A4) | Output types — no message/disruption field. |
| `RdmBoard` / `RdmService` | `darwin-client.ts:62-67` / `:50-60` (A4, B3); input types `:36-67` | No `nrccMessages`/`cancelReason`/`delayReason`. |
| normalisation loop | `darwin-client.ts:85-115` (A4) / `:85-114`, NrBoard built `:109-114` (B3); cancelled derived at `:96` (`isCancelled===true || etd==='Cancelled'`) | Keeps only serviceID/std/etd/platform/operator/origin/destination/isCancelled/callingPoints. |
| `HUBS` | `backend/src/nr-sampler.ts:26` | 17 CRS: WAT/VIC/LBG/LST/KGX/STP/EUS/PAD/MYB/CHX/CST/FST/MOG/BFR/CLJ/SRA/ECR. Identical list at `frontend/src/realtime/nr-trains.ts:22`. |
| `makeCachedNrBoardFetcher` | `nr-sampler.ts:81-106`; `cache.set(crs, upstream.body)` at `:93-96` (B3) | cache-first / budget-gated / stale fallback. |
| `loadNrGraph` | `nr-sampler.ts:111-124` | Reads `data/nr/stations.json` + `segments.json`. |
| `NrSampler.tick` | `nr-sampler.ts:152-170` | One hub per 15s tick, round-robin; driven by `leaderboard.ts:23,317,442-444`. |
| `NrRailGraph` / `railPath` | `backend/src/shared/nr-inference.ts:160-241` (constructor 167-185, Dijkstra 195-240), `MAX_PATH_M=60_000` line 115, `PATH_CACHE_MAX=300` line 116 | Frontend closure copy: `frontend/src/realtime/nr-trains.ts:243`. Header `nr-inference.ts:1-8` says hand-synced COPY. |
| `NrStation`/`NrSegment` | `nr-inference.ts:18-30`; frontend `nr-trains.ts:27-39` | `{crs,name,lat,lon}` / `{a,b,lenM,poly}`. |
| `NR_GATEWAYS` / `NR_GATEWAY_SNAP` | `nr-inference.ts:66-106` / `:66-108` | 26-entry out-of-box snap table (e.g. Reading, Milton Keynes Central, Gatwick Airport, Tonbridge). |
| `mergeBoard` | `nr-inference.ts:249-290`; skips cancelled at `:256`; frontend skips at `nr-trains.ts:350` | Where per-station message retention would also need to happen if messages travel with train state. |
| Frontend NR types | `nr-trains.ts:49-64`; `BOARD_STAGGER_MS=4_000` line 24; `pollNextBoard` 336-392; delayed flag `:381` | Also drop `nrccMessages`/`delayReason`. |
| `scripts/bake-nr-graph.mjs` | bbox line 34: south 51.25, west -0.55, north 51.72, east 0.35 | Adjacency = station-to-station shortest path avoiding other stations' 300m zones. |
| `docs/OVERGROUND_DARWIN_PLAN.md` | untracked, 2026-07-26, status 待实现 / analyzed-not-built | Wants to grow HUBS and consume the same darwinBudget; section 4 table: "现只轮询约17个国铁枢纽... 加Overground车站会挤占预算，需规划轮询轮转". |

Grep (B3) for `nrccMessages|cancelReason|delayReason|adhocAlerts|affectedByDiversion|futureDelay` across `backend/src`, `frontend/src`, `scripts`, `docs` = 0 hits. A1: grep for `affectedStops`, `affectedRoutes`, `nrccMessages`, `StatusEffect` across `backend/src` and `frontend/src` returned zero matches (exit code 1) — contradicted for `affectedRoutes`/`affectedStops` by A2/B1's reading of `tube-status-recorder.ts` (see 1.9).

### 1.4 Frontend consumers of status text (A1, A5, B1)

- `frontend/src/ui/vehicle-popup.ts` `fetchDetail()` lines 114-190: only `/api/line-status` consumer (fetch line 141, click-triggered). Parsing 173-186/173-187: `entries[0].lineStatuses`, `statusSeverityDescription` filtered `!== 'Good Service'` (`GOOD_SERVICE` const line 16), `reason` deduped via `[...new Set(...)]` (lines 181/185, `lineStatusReasons` 182-185). Rendered 230-234 with `.vp-status`/`.vp-reason`, `STATUS_REASON_MAX_CHARS=140` (line 17, 233). Local `esc()` at 19-20.
- `frontend/src/ui/station-popup.ts`: `fetchEnrichment()` 222-243 (Promise.allSettled; `/api/lift-disruptions` at 230); `findLiftDisruption()` 186-200 — matches by (1) `stationUniqueId` prefix vs naptanId (line 191, `naptanId.startsWith(uid) || uid.startsWith(naptanId)`), (2) case-insensitive substring of station name in `stopPointName` (line 194), (3) substring in first 60 chars of free-text `message` (line 196; messages open 'WEMBLEY PARK STATION: ...'). `footerHtml` 245-264 (`.sp-tag`/`.sp-warn`/`.sp-fact`); `injectPopupStyles()` 35-60 guarded by `ENRICH_STYLE_ID`; `truncate` exported at line 26; `setupStationPopups` 268-317 with `seq` guard (289, 294-296, 309, 314) and loading placeholder 290-298; local `esc` 23-24.
- `frontend/src/layers/road-disruptions.ts`: `SOURCE_ID` + `LAYER_IDS` 14-21; `POLL_INTERVAL_MS` 120s line 25; severity->colour + `DEFAULT_COLOR` 30-35; `toFeatures()` 44-135 (`toProps()` 103-111 keeps only category/severity/location/comments/color — client-side trimming after paying egress); local `esc()` 55-56; `wireInteractions(map, layerId)` 150-175; `poll()` via `registerPoll` 229-251, keeps previous picture on failure. Does NOT use render-gate.

### 1.5 Frontend layer conventions (A5)

- `frontend/src/util/lifecycle.ts:75-79` `registerPoll(fn, ms)` — mandatory `setInterval` replacement; visibilitychange pause/resume at 109-111; `symbolTierIntervalMs`/`isMobile` also here.
- `frontend/src/util/render-gate.ts:22-32` `makeRenderGate(minIntervalMs)`; `:35-38` `isLayerShown(map, layerId)` — only for per-frame animated layers.
- `frontend/src/util/layer-order.ts:15-17` `below(map, layerId)` — returns layerId only if present, else undefined (addLayer throws on unknown beforeId).
- `frontend/src/layers/stations.ts:28-30` `STATIONS_SOURCE_ID='stations'`, `STATIONS_CIRCLE_LAYER_ID='stations-circle'`, `STATIONS_LABEL_LAYER_ID='stations-label'`; dedup by NaPTAN id 79-112 (`StationAccumulator`), `lines` count (interchange >=2, line 34), `lineIds` comma-joined (106); `STATION_MIN_ZOOM=10` (32), `LABEL_MIN_ZOOM=12.5` (33); zoom-interpolated paint 43-71.
- `frontend/src/layers/transit-lines.ts:22-24` `TRANSIT_LINES_SOURCE_ID='transit-lines'`, `TRANSIT_LINES_CASING_LAYER_ID='transit-lines-casing'`, `TRANSIT_LINES_LAYER_ID='transit-lines-line'`; merged FeatureCollection with `lineId`/`color` props 99-109; inserted `beforeId = findFirstSymbolLayerId(map)` 112-114, 129-159; `LINE_WIDTH_RAMP` 36-48 (exponential 1.4); width/casing/offset ramps 36-97.
- `frontend/src/ui/control-panel.ts:22-28` `TabKey`/`ALL_TABS` (board/filter/lines/about); filter tab requires `hasLayer('buses')` (41); mount pattern 85-92 / 30-108. A disruptions layer is NOT a new tab.
- `frontend/src/ui/legend.ts:42-53` `OverlayToggle {label, layerIds, startOff?, onToggle?}`; Overlays rendering 146-168; visibility flip 75-77; custom `onToggle` 71-73; `FILTERED_LAYERS` line 9.
- `frontend/src/ui/hover-tooltip.ts:10-11` local `esc()`; ownership chain vehicle > station > line at 150-163 (`queryPresent(map, e.point, [VEHICLES_LAYER_ID])`), 169-181, 129-197. 12 files define their own `esc`.
- `frontend/src/region.ts:86-88` `hasLayer(name)`; `loadCapabilities()` 96-111; `LONDON_FALLBACK` 31-61.
- `frontend/src/main.ts:375-450` `LAYERS` registry `{name, row, start, overlay}`; `hasLayer` gate 452; `Promise.allSettled` 452-453; overlays list 460-463; `addTransitOverlays` 339-498.
- CSS: `frontend/index.html` inline `<style>` lines 7-271 (`.vp-status` amber at line 53; `.vp`, `.vp-dim`, `.vp-reason`, `.sp-title`, `.sp-row`/`.sp-chip`/`.sp-dest`/`.sp-eta`/`.sp-plat`, `.sp-tag`/`.sp-warn`/`.sp-fact`, `.tip-chips`, `.hover-tip`, `.legend-row`/`.legend-swatch`/`.legend-group`, `.map-toast`).
- Tests: no `vitest.config.ts`; `frontend/vite.config.ts:1-33` has no `test:` block (node env, no DOM). 6 vitest files in `src/`. `frontend/src/layers/emergency-classify.test.ts:1-46` and `frontend/src/ui/bus-filter.test.ts:1-113` use `vi.mock('maplibre-gl', () => ({ Popup: class {} }))` + dynamic import; `bus-filter.test.ts:12-21` shows Arrange/Act/Assert. `frontend/src/realtime/interpolator.test.ts` and `position-inference.test.ts` import pure modules with no mock.
- Diversions render pattern (worktree only): `frontend/src/layers/diversions.ts` lines 21-138, 239-256 (`STATUS_COLOR`/`STATUS_OPACITY` + `toFeatures`, MultiLineString wash with popup).

### 1.6 Baked data (A2, B1, A4)

- `data/manifest.json`: 25 lines (`id`, `name`, `mode`, `color`, listing from line 3). `ls data/{lines,stations,branches}` = 25 files each; `missing from data/lines: []`.
- `data/stations/<lineId>.json`: GeoJSON FeatureCollection, `properties:{id (NaPTAN e.g. 940GZZLUERC), name, lineId}`, Point `[lon,lat]`; written by `scripts/bake-routes.mjs:350-360` from a per-line `stationById` map. Sample: `data/stations/bakerloo.json` `{"id":"940GZZLUEAC","name":"Elephant & Castle","lineId":"bakerloo"}`. Total `data/stations/` 160 KB (~270 rail-mode stops per A3; A2 counts 676 rows / 537 ids — see 4.1).
- `data/branches/<lineId>.json`: `{lineId, branches:[{branchId, direction:'outbound'|'inbound', stops:[{id,name,lon,lat}] (ORDERED), segments:[[[lon,lat],...],...]}]}` written by `bake-routes.mjs:361-364`; `segments[i]` is the polyline strictly between `stops[i]` and `stops[i+1]`, built by `trackSegment()`/`subPolyline()` (`bake-routes.mjs:96-130`), straight 2-point fallback when no TfL polyline snaps within `MAX_SNAP_M=250`m (lines 109, 318-321). Branch loop 263-337; fragments stored as-is at 286-296. `LINES` enumeration `bake-routes.mjs:21-49` covers tube/dlr/elizabeth-line/overground/tram/cable-car/river-bus — no `'bus'` (empty grep).
- `data/nr/stations.json`: 431 rows `{crs,name,lat,lon}`, 5dp coords, single-line minified 28,318 bytes (`wc -l` 0). `data/nr/segments.json`: 579 rows `{a,b,lenM,poly}`, 494,362 bytes.
- Bus: `data/bus-routes/learned/<key>.json` = `{key, poly, quality:{journeys, meanResidualM}}` (verified `data/bus-routes/learned/AKSS_402_outbound.json`); `data/bus-routes/prior/<key>.json` = `{key, poly, stops}` with `stops` bare `[lon,lat]` (verified `data/bus-routes/prior/ARBB_1_clockwise.json`). 1588 learned files / 24 MB on the worktree volume (1580 / 24 MB on local main); prior 11 MB across ~1736 files.

### 1.7 Bus side touchpoints (A3)

- `backend/src/bods-client.ts:14-42` `Bus`/`BusWire`: id/line/operator/direction/dest/lat/lon/bearing/recordedAt — no stop id; `parseSiriVm` 76-106 never reads MonitoredCall/OnwardCall.
- `backend/src/routes/bus-routes.ts`: `/api/bus-routes-index` and `/bus-routes/learned/:file` straight off disk.
- `scripts/fetch-bus-prior.mjs:250-260` `stopLoc` map keyed by `StopPointRef` (line 253) / `AtcoCode` (line 258); ref discarded at `stops.push(loc)` 316-320; no `CommonName`/`Descriptor`/`StopPointName` parsed.
- `.claude/worktrees/rollup-attribution/scripts/learn-bus-routes.mjs:562-582` stop-snap; `STOP_ANCHOR_RADIUS_M=40` (79), `STOP_ANCHOR_PULL=0.5` (80).
- `.claude/worktrees/rollup-attribution/frontend/src/layers/buses.ts:770` `sanitizeKey(\`${bus.o}:${bus.l}:${bus.r}\`)`, `sanitizeKey` at 282 (e.g. `TFLO_88_outbound`).
- `.claude/worktrees/rollup-attribution/frontend/src/ui/bus-filter.ts:1-5` header, 20-21 (~600-700 routes), `normalizeLine`/`suggestLines` 26-53.
- `.claude/worktrees/rollup-attribution/backend/src/diversion-events.ts`: `TFL_MATCH_DIST_M=250` (32), `buildApiEvents` 570-621 (midpoint comment 584-589; `slicePolyline` use 602-605), `parseDisruptionSnapshotLine` 637-662, `matchTfl` 664-676 (628-676 as a block).
- `.claude/worktrees/rollup-attribution/backend/src/diversion-detector.ts`: imports `buildRouteIndex` at line 45 (also 627).
- `.claude/worktrees/rollup-attribution/backend/src/route-projection.ts`: `buildRouteIndex` line 51, `slicePolyline` line 233.

### 1.8 Frontend position-inference helpers (A2)

`frontend/src/realtime/position-inference.ts`: `normStation()` 50-60; `findCandidates` 162-170, `pickCandidate` 177-202, `segmentKeyFor` 204-206, `segmentRunTime` 221-231, `positionOnBranch` 233+ — all single-prediction next-stop matching, none take two arbitrary stations.

### 1.9 Inconsistencies between sub-reports (kept, not resolved)

- `fetchLineStatusByModes`: A1 says lines 48-54, no params, "No existing caller passes `detail=true`", and grep for `affectedStops`/`affectedRoutes` = 0 hits. A2 and B1 say lines 53-60 (B1 also 55-61) with a `withDetail` argument, called with `true` from `tube-status-recorder.ts` (`:253-256` / `:256`), and that `tube-status-recorder.ts:100-169` / `:156-171` compacts `affectedRoutes`/`affectedStops`. Different checkouts are a possible cause (1.0) — unverified.
- `tflBudget` at `app.ts:202` (A1) vs `app.ts:249` (A3).
- `STATUS_MODES` at `tube-status-recorder.ts:16` (A2) vs `:17` (A1, B1).
- `fetchNrBoard` at `darwin-client.ts:67-107` (A1) vs `:70-116` (A4).
- A1: `TubeStatusRecorder` writes archive to `join(baseDir, 'tube-status')` (line 103) / line 154; B1: `SUBDIR` line 18.
- Archive corpus sizes differ because windows differ: A1/A2 6 day-files (2026-08-28..09-02), 316 snapshot lines, 3074 `"r":"..."` occurrences / 7110 line-status entries (4036 Good Service), 216 distinct reasons; B2 10 days (2026-08-23..09-01), 1113 snapshots, 11476 reason occurrences, 604 distinct strings, 20 line ids.
- `data/stations/` size: A3 "~270 rail-mode stops, 160 KB"; A2/B1 676 feature rows / 537 distinct ids / 496 distinct names.

---

## 2 Data sources and what each field actually contains, as measured

### 2.1 TfL probe conditions (B1)

14 of 15 calls used (1 timeout: bus detail without `--compressed`, 20 s; 1 404: date-window by mode). `fetch.sh` appends `app_key` from `backend/.env` at runtime; all saved bodies scrubbed (grep for key over samples: 0 hits). Network QUIET at probe time (Wed 2026-09-02 ~20:18 UTC): only 3 rail lines disrupted (northern/victoria minor delays, windrush part-suspended). RealTime structured behaviour observed on ONE line (windrush); live-incident conclusions from n=5 statuses; planned-work conclusions from a 7-day window with 11 more entries across 5 lines.

### 2.2 `/Line/Mode/{tube,dlr,overground,elizabeth-line,tram}/Status?detail=true` (sample 01)

- Size 398,979 B raw / 12,689 B gzip; 20 lines, 22 lineStatuses; `affectedRoutes` JSON = 362,192 B (91% of payload).
- 5 disruption entries = lineStatuses with `statusSeverity!=10`: 17 Good Service(10), 2 Minor Delays(9), 1 Severe Delays(6), 2 Part Suspended(3). `disruption` object exists only on non-Good statuses; line-level `disruptions[]` array empty on 20/20.
- Non-empty `affectedRoutes` 5/5, `affectedStops` 2/5, `validityPeriods` 5/5. `validityPeriods` live on lineStatus (`fromDate,toDate,isNow`), not inside disruption. The 2 with stops are both windrush partSuspended (3 and 7 stops); minorDelays x2 and severeDelays have 0 stops.
- `category` RealTime:5; `closureText` minorDelays:2 severeDelays:1 partSuspended:2 — an enum token, never a sentence.
- `lineStatus.reason == disruption.description` on 5/5 (byte-identical after trim); `summary`/`additionalInfo` absent; 5/5 reasons start with `'<Line> Line:'`; 3/5 contain 'between X and Y'; 5/5 contain ' at <Station>'.
- `affectedStops` id kind: 910G station ids 10/10 (windrush); lat/lon = 0 on 10/10; duplicates 0; no 9400… platform ids, no HUB ids. Positions MUST be joined from `data/stations`.
- `affectedRoutes` section semantics: 36 routes, `isEntireRouteSection` true 26 / false 10; seqLen 3..32. true -> sequence == whole route (northern 16 routes ordinals 0..31/30/28/22/21, count equals `line.routeSections=16`; victoria 2 = full 16-stop line; windrush severeDelays 8 = full 13/18/21-stop routes). false -> ONLY the disrupted section: windrush partSuspended ordinals 18..20 / 15..17 / 0..2 (3 stops Dalston Jn–H&I) and 0..6 / 11..17 (7 stops Clapham Jn–Surrey Quays). All 668 sequence stopPoints have lat/lon 0.
- Sequence id kinds: 940GZZLU 482, 910G 178, other-940G 8 (940GZZNEUGST Nine Elms, 940GZZBPSUST Battersea Power Station). All distinct seq ids matched baked files: northern 52/52, victoria 16/16, windrush 29/29 (`naptan-match.mjs`).

### 2.3 `/Line/Mode/…/Status` without detail (sample 02)

19,290 B raw / 1,332 B gzip. Same key set at line and lineStatus level. `disruption` object IS present without detail but `affectedRoutes`/`affectedStops` EMPTY on 4/4; category/closureText/description present. `routeSections` on Line objects: 0 without detail vs 16/2/8 with detail (only populated for disrupted lines). 4 vs 5 disrupted statuses between the two calls seconds apart — feed churns.

### 2.4 `/Line/Mode/{rail}/Disruption` (sample 03)

2,285 B raw / 481 B gzip; 5 entries; `affectedRoutes` 0/5; `affectedStops` 0/5; `validityPeriods` key absent; no created/lastUpdate. category RealTime:5; type lineInfo:3 routeBlocking:2; closureText minorDelays:2 severeDelays:1 partSuspended:2; description carries sentence 5/5 (same text as 01 reason; windrush appears 3x: 1 lineInfo + 2 routeBlocking, one per suspended section but WITHOUT stops). No `lineId` field — line only from the '<Line> Line:' prefix. Strictly less information than 01/02.

### 2.5 `/StopPoint/Mode/{rail}/Disruption` (sample 04)

- 45,754 B raw / 5,192 B gzip; 77 entries; 55 distinct stations. atcoCode kinds: 940GZZLU 29, 910G 44, 940GZZDL 4 — station-level (`atcoCode==stationAtcoCode` 77/77, no 9400 platform ids, no HUB ids); 77/77 atcoCodes exist in `data/stations/*.json`. fromDate+toDate 77/77; description 77/77; `concernedLines` non-empty 2/77 only (Barons Court: circle,district,piccadilly). type: Interchange Message 29, Information 32, Part Closure 12, Closure 4. appearance: RealTime 51, Information 14, PlannedWork 12. closureText: partSuspended 10, partClosure 2, null 65. mode: tube 29, overground 26, elizabeth-line 18, dlr 4. Cross type/appearance: Part Closure/RealTime 11, Interchange Message/RealTime 25 (escalator/lift faults), Information/RealTime 15. 24/77 descriptions start with an UPPERCASE 'STATION NAME:' prefix. 16 stations carry >1 entry.
- Mirrors live line status per station: 10/10 partSuspended rows == union of windrush `affectedStops` in 01 (ids 910GHGHI, 910GCNNB, 910GDALS, 910GCLPHMJ1, 910GCLPHHS, 910GDENMRKH, 910GPCKHMQD, 910GPCKHMRY, 910GSURREYQ, 910GWNDSWRD), same fromDate/toDate (19:09->23:17Z) as the lineStatus validityPeriod, identical description. So StopPoint/Disruption = per-station projection of Line/Status affectedStops + station-facility notices (Barons Court westbound not stopping; 54 lift/escalator/footbridge/interchange notices); adds nothing for section localisation beyond sample 13. Right feed for station-pin badges ('westbound trains not stopping', 'station closes 23:35').

### 2.6 Date-window form (samples 08, 08a, 13) — the recommended source

- `/Line/Mode/{modes}/Status/{from}/to/{to}` -> HTTP 404 EntityNotFoundException; `/Line/{19 ids}/Status/2026-09-02/to/2026-09-09` -> 200. The 404 body echoes the full request URI INCLUDING app_key in `relativeUri` and `message` (scrubbed to `REDACTED_APP_KEY` in `08a_rail_status_window_by_mode_404.json`). Line ids must be enumerated (manifest.json ids for tube/overground/dlr/elizabeth-line; tram not in the window probe).
- 08 window without detail: 34,168 B raw / 3,603 B gzip; 19 lines; 25 statuses; 14 with disruption. severity: Good 11, Part Closure(5) 7, Planned Closure(4) 2, Reduced Service(7) 1, Minor Delays 2, Severe 1, Part Suspended 1. category PlannedWork 9 RealTime 4 Information 1; closureText partClosure 7 plannedClosure 2 reducedService 1 minorDelays 2 severeDelays 1 partSuspended 1. validityPeriods on 14 statuses, 20 periods with `isNow=false`; multi-period statuses exist (weaver 5 periods, waterloo-city 4, windrush evening closure 4). affectedRoutes/affectedStops EMPTY 14/14 without detail.
- 13 window WITH `detail=true`: 668,074 B raw / 23,959 B gzip; 26 statuses; 15 disruption objs; affectedRoutes non-empty 15/15; affectedStops non-empty 11/15. The 4 without stops are all entire-route: northern/victoria minorDelays, waterloo-city plannedClosure (weekend-only line), windrush severeDelays. 103 affectedStops total, 0 duplicate ids, lat/lon 0 on 103/103, 103/103 present in `data/stations/<that line>.json` (district 14/14, elizabeth 4/4, suffragette 11+3, weaver 15/15, windrush 7,5,29,5,7,3). Every `isEntireRouteSection=false` section has contiguous ordinals (district 8 sections, elizabeth 16, suffragette 4, weaver 4, windrush 14) — the section = a slice of the route's stop list, directly mappable to baked track segments (`window-detail-match.mjs`). Sample file `13_rail_status_window_detail.json` (24 KB gz). It is a superset of the Mode form (RealTime with `isNow=true`) plus PlannedWork/Information with future validityPeriods.

### 2.7 `/Line/{id}/Route/Sequence` (samples 09, 09b)

- windrush: `stopPoint[].id` 29/29 and `stopPoint[].stationId` 29/29 match `data/stations/windrush.json`; `stations[].id` only 18/29 (11 HUB ids: HUBCLJ HUBCYP HUBHHY HUBNWD HUBNWX HUBNXG HUBSDE HUBSYD HUBWCY HUBZCW HUBZWL). 80,936 B raw / 5,009 B gzip; stations 29, stopPointSequences 6 (12/6/5/7/2/2 stops), orderedLineRoutes 4 (13/18/21/18 naptanIds). parentId mixes HUB*/910G/empty. Use `stopPoint.id` or `stationId`, never `stations[].id`.
- northern: `stopPoint[].id` 52/52 match `data/stations/northern.json`; `stations[].id` 40/52 (12 HUB ids). 133,443 B raw / 7,701 B gzip; 8 orderedLineRoutes (22/23/31/29/32/31/29/32). `affectedRoutes[].id` values ('2105','2330'…) do not appear in Route/Sequence output (orderedLineRoutes have no id) — correspondence unverified.

### 2.8 Bus endpoints (samples 05, 14, 06, 07)

- 05 `/Line/Mode/bus/Status?detail=true`: 10,418,827 B raw / 681,067 B gzip. First attempt (no `--compressed`, 20 s max-time) -> http 000 timeout; succeeded with `--compressed`. `affectedRoutes` = 9,467,210 B (91%). 678 lines, 733 statuses. Not Good Service: 162 lines (of 678) / 217 statuses, ALL `statusSeverity 0 'Special Service'` (no other severity used for bus). disruption obj 217; affectedRoutes non-empty 214/217; affectedStops non-empty 3/217 (all 490015057H Willesden Junction Station on lines 18/n18/n118); validityPeriods 217/217; category PlannedWork 157 RealTime 57 Information 3; closureText undefined 217/217; reason == disruption.description 217/217. 387 affectedRoutes, `isEntireRouteSection` true 387/387, seqLen 10..113 (17,322 490-stop entries; seq id prefixes 4900 17,322; 2400 130; 4000 116; 1500 108; 2100 48; 0370 38 — non-490 are out-of-London NaPTAN areas). Zero localisation value. Never proxy it.
- 14 `/Line/Mode/bus/Status` (no detail): 745,266 B raw / 41,356 B gzip. Same 217 statuses with reason, validityPeriods, `disruption{category,description,created}` — affectedRoutes/affectedStops empty 217/217. This, not 05, is the usable bus line feed (15x smaller gz).
- 06 `/Line/Mode/bus/Disruption`: 29,042 B raw / 5,144 B gzip; 49 entries; affectedRoutes 0/49; affectedStops 0/49; validityPeriods absent; created 49/49 lastUpdate 49/49. category RealTime 48 Information 1; type lineInfo 48 stopInfo 1; closureText null 49/49; description 147–571 chars. NO route/line id field: route only in prose ('ROUTE 200', 'ROUTES 41 230 N41' — 31/49 mention ROUTE(S)); 46/49 start with 'STREET NAME, POSTCODE:'; 17/49 contain quoted stop names like 'Watney Market' (K); 48/49 mention 'stop'. Example prose: 'ROUTE 200 … stops from High Cedar Drive to Woodhayes Road'.
- 07 `/StopPoint/Mode/bus/Disruption`: 123,797 B raw / 9,286 B gzip; 303 entries; 188 distinct stationAtcoCode. atcoCode 490… bus-stop ids 303/303 (stop-level, not station); stationAtcoCode 490G… group 280, empty 19, 940GZZDL 2, 910G 2. type Closure 302 Information 1; appearance Information 303; closureText null 303; fromDate/toDate 303/303 (21 start in the future, 0 stale); 14 say 'next or previous stop'.

### 2.9 Concrete agreement examples: prose vs structured fields (B1)

- [a] windrush Part Suspended #1 (RealTime) — AGREE. reason: 'Windrush Line: No service between Clapham Junction and Surrey Quays and between Highbury & Islington and Dalston Junction due to a points failure at Peckham Rye. SEVERE DELAYS on the rest of the line due to a trespasser at Sydenham…' — affectedStops: Canonbury, Dalston Junction, Highbury & Islington (3) = second 'between' clause incl. intermediate Canonbury; 8 affectedRoutes all `isEntireRouteSection=false`, each a 3-stop Dalston Jn<->H&I slice. Cause locations 'at Peckham Rye' / 'at Sydenham' are NOT marked (Sydenham in no affectedStops).
- [b] windrush Part Suspended #2 (RealTime) — AGREE. Same sentence; affectedStops: Surrey Quays, Clapham High Street, Clapham Junction, Denmark Hill, Queens Road Peckham, Peckham Rye, Wandsworth Road (7) = first 'between' clause, all 7 stations of that branch; 2 affectedRoutes (inbound ordinals 0..6, outbound 11..17). TfL emits ONE lineStatus per suspended section, all sharing one sentence — dedupe on the sentence, union the stops.
- [c] district Part Closure (PlannedWork, 2026-09-05 02:30Z -> 09-07 00:29Z, `isNow=false`) — AGREE. reason: 'District Line: Saturday 5 and Sunday 6 September, no service Edgware Road - Wimbledon. Rail Replacement bus services will operate.' (no 'between', uses ' - '); affectedStops (14): 940GZZLUERC Edgware Road (Circle Line), 940GZZLUPAC Paddington, Bayswater, Notting Hill Gate, High Street Kensington, Earl's Court, West Brompton, Fulham Broadway, Parsons Green, Putney Bridge, East Putney, Southfields, Wimbledon Park, Wimbledon = exactly the Edgware Road–Wimbledon path. The ids disambiguate 'Edgware Road' (baked has Bakerloo and Circle Line variants) and 'Paddington' (2 ids) — prose parsing alone could not. 10 affectedRoutes: 8 partial (Earl's Court<->Wimbledon 9 stops; Edgware Road<->Earl's Court 6 stops) + 2 entire.
- [d] counter-examples (point incidents) — NO STATION IN STRUCTURED FIELDS. northern 'Minor delays due to an earlier points failure at Camden Town' and victoria '…signal failure at Highbury & Islington': affectedStops 0, affectedRoutes 16/2 all `isEntireRouteSection=true`. Likewise windrush severeDelays (sev 6) lists 8 entire routes and 0 stops although its sentence names sections. Rule: only trust affectedStops / `isEntireRouteSection=false` for localisation; treat entire=true as line-level; the ' at <Station>' location exists only in prose.

### 2.10 Archived recorder evidence on structured-field population (A2)

Real archive `.claude/worktrees/rollup-attribution/data/tube-status/*.jsonl`, 6 days 2026-08-28..09-02, 316 snapshot lines, 7110 line-status entries, 4036 Good Service / 3074 non-good with a `reason`: `disruption.affectedRoutes` (`ar`), `disruption.affectedStops` (`as`), `category`/`closureText` (`c`/`ct`) appear ZERO times (`grep -c '"ar":' *.jsonl` and `grep -c '"as":' *.jsonl` both 0 on every file; confirmed with a JS parse-and-count) even though the recorder requests `?detail=true`. In this window the structured path was 0% populated. (B1's live probe on 2026-09-02 did observe populated `affectedRoutes`/`affectedStops` on windrush and on planned closures — both observations are kept; the discrepancy is not explained by any sub-report — unverified.)

### 2.11 Darwin `GetDepBoardWithDetails` (B3, A4)

- 6 boards sampled (WAT, LBG, CLJ, SRA, EUS, VIC) at 2026-09-02T20:19:16–18Z (board generatedAt 21:19 BST) with the exact request shape from `darwin-client.ts`; all HTTP 200; bytes WAT 54615, LBG 119379, CLJ 40950, SRA 97195, EUS 57984, VIC 132663. Raw JSON saved as `<crs>.json` in the darwin samples dir. A4 separately curl'd CLJ: 7,071 bytes for 3 services + 4 messages; messages array ~1-1.5 KB regardless of numRows.
- Top-level keys: `trainServices, generatedAt, locationName, crs, filterType, [nrccMessages], platformAvailable, areServicesAvailable, Xmlns`. `nrccMessages` present only when there are messages (absent on WAT and SRA). `busServices`/`ferryServices` absent on all 6.
- `nrccMessages` per station: WAT 0 (key absent), LBG 2, CLJ 4, SRA 0, EUS 2, VIC 2 = 10 occurrences, 7 distinct texts. Element shape `{ "Value": "<html string>" }` only — no severity/category/id/timestamp (verified on all 10). 10/10 contain an `<a href="https://www.nationalrail.co.uk/...">Status and Disruptions</a>` link; 3/10 wrapped in `<p>`; 2 contain `&nbsp;`, 1 contains `&amp;`. Duplicates across boards: Peckham Rye (LBG+CLJ), Horsham–Barnham/Bognor/Portsmouth (CLJ+VIC), Haywards Heath–Lewes (CLJ+VIC).
- Sample texts (HTML stripped): (1) 'Trains running through Peckham Rye may be cancelled, delayed by up to 70 minutes, revised or diverted. Latest information can be found in Status and Disruptions.' [LBG,CLJ] | (2) 'Trains running between Uckfield and Oxted may be revised, Latest information can be found in Status and Disruptions.' [LBG] | (3) 'Trains running between Horsham and Barnham / Bognor Regis / Portsmouth Harbour may be revised. Latest information can be found in Status and Disruptions.' [CLJ,VIC] | (4) 'Haywards Heath to Lewes railway is open following major repair programme. Latest information can be found in Status and Disruptions.' [CLJ,VIC] | (5) 'A reduced service is in operation between Highbury & Islington and Clapham Junction / West Croydon. Latest information can be found in Status and Disruptions.' [CLJ] | (6) 'A reduced London Northwestern Railway service is in operation on some routes. More details can be found in Status and Disruptions.' [EUS] | (7) 'Trains through Carlisle and Lockerbie may be delayed by up to 30 minutes. More details can be found in Status and Disruptions.' [EUS]. Every message ends with boilerplate 'Latest information/More details can be found in Status and Disruptions'. Link slugs carry place+date (peckham-rye-20260902, uckfield-20260828, amberley-20260828, lewes-20260813, windrush-line-20260902, status-and-disruptions/) — 'amberley' is NOT in the visible text.
- Per-service key union (raw RDM): `subsequentCallingPoints, futureCancellation, futureDelay, origin, destination, std, etd, platform, operator, operatorCode, isCircularRoute, isCancelled, filterLocationCancelled, serviceType, length, detachFront, isReverseFormation, serviceID, rsid, formation, delayReason (only when set), cancelReason (only when set)`. `adhocAlerts` absent from all 6 payloads; `divertedVia`/`diversionReason`/`uncertainty` absent.
- `isCancelled`: present 120/120, true 3/120 (all EUS, operatorCode LM: 21:23 EUS->Northampton, 21:53 EUS->Milton Keynes Central, 22:39 EUS->Northampton), each `etd='Cancelled'`, all calling points `isCancelled=true` (6/6, 12/12, 13/13).
- `cancelReason`: 3 services (EUS only) + copied onto 31 calling-point objects. Texts: 'This service has been cancelled because of a speed restriction over defective track earlier today' (1), 'This service has been cancelled because of a shortage of train crew' (2). No place name. First cancelled CRS WFJ / HRW / HRW; of those services' cancelled calling points 1/6, 4/12, 3/13 are in `stations.json`.
- `delayReason`: 10 services (LBG 6, CLJ 2, SRA 1, VIC 1) + 50 downstream calling-point objects (LBG 40, CLJ 2, VIC 8). Texts: '...delayed by a speed restriction' (3), '...by a speed restriction over defective track' (3), '...by a points failure' (1), '...by train crew being delayed by service disruption' (1), '...by a safety inspection of the track' (1), '...by a problem currently under investigation' (1). No place names; calling-point copies identical to the service-level string.
- `etd` (120 services): 'On time' 97, 'Cancelled' 3, HH:MM 20 (no bare 'Delayed' seen). Per-board: WAT all On time; LBG 11/9; CLJ 13/7; SRA 18/2; EUS 16 On time/1 HH:MM/3 Cancelled; VIC 19/1.
- `futureDelay` true 1/120 (SRA 21:16 Shenfield->Heathrow T5, etd 'On time', no delayReason); `futureCancellation` 0; `filterLocationCancelled` 0.
- Calling-point keys: `locationName, crs, st, et, isCancelled, length, detachFront, affectedByDiversion, rerouteDelay` (+ `delayReason`/`cancelReason`/`formation` when set). `affectedByDiversion` true 0/1267; `rerouteDelay` nonzero 0/1267. Calling points per board: WAT 251, LBG 154, CLJ 161, SRA 196, EUS 245 (31 cancelled), VIC 260.
- Which fields carry a location: `nrccMessages` free-text place names only (no CRS); `cancelReason`/`delayReason` none; structured location = calling-point `crs` where `isCancelled=true`.
- Gazetteer hit on the 14 named places: PRESENT 5 — Peckham Rye (PMR), Oxted (OXT), Highbury & Islington (HHY), Clapham Junction (CLJ), West Croydon (WCY); MISSING 9 — Uckfield, Horsham, Barnham, Bognor Regis, Portsmouth Harbour, Haywards Heath, Lewes, Carlisle, Lockerbie (all outside the bbox lat 51.253–51.718, lon -0.546–0.342). Per message: fully resolvable 2/7, partial 1/7 (Uckfield–Oxted: Oxted only), none 3/7, no place 1/7. Name match used lower-case + '&'->'and' + punctuation collapse.
- A4's CLJ sample also named Amberley, Lewes, Barnham, Bognor Regis, Portsmouth Harbour, Horsham — unresolvable, not in the 26-entry `NR_GATEWAYS` either.

---

## 3 Corpus statistics and template inventory

### 3.1 B2 corpus (10 days, 2026-08-23..09-01)

- 1113 snapshots, 11476 reason occurrences, 604 distinct strings, 20 line ids.
- Location-phrase presence (distinct strings): 510/604 have a capitalised location phrase after between/and/at/from/to/via/towards (408 with "between", 101 with only an "at <cause station>"); 94 have none (line-wide: "Minor delays due to train cancellations", "Service will resume later this morning", empty "Liberty Line:"). The earlier "428 of 604 carry a location phrase" figure is NOT reproduced by any definition tried: LOC-class phrase after any of the 7 keywords 510; regex `/\b(between|at|from|to|via|towards)\s+[A-Z]/` 511; 'between' only 408; 'between|at' 509; 'between|from' 409; any strict gazetteer name anywhere 504 — treat 428 as superseded (unverified why).
- Gazetteer: `data/stations/*.json` 676 features + `data/nr/stations.json` 431 = 769 strict keys. Of 197 distinct location phrases, strict normalisation matches 149; relaxed rules 181; 10-entry hand alias table + line-scoped prefix + edit-distance-1 reach 194; 3 remain (Wembley Arena, Notting Hill, Aylesbury), none a station on the map.
- Empty reasons: 6 distinct strings / 66 occurrences are just the line-name prefix ('Liberty Line:', 'Weaver Line:').
- Skeletons: 482 distinct (strict, stations->'<STN>') / 464 (relaxed) / 458 after masking `<DATE>`/`<TIME>`/`<ROUTE>`/`<N>`/`<STN-LIST>` and the 'X line:' prefix. Long-tailed, but ~85% of location-bearing strings are one of a handful of "<severity> between <STN> and <STN> [and <severity> on the rest of the line] [while we fix|due to] <cause> at <STN>" shapes.

### 3.2 Parseability ladder (FULL/PARTIAL/NONE of 604 distinct)

| Tier | FULL | PARTIAL | NONE | Occurrence-weighted |
|---|---|---|---|---|
| STRICT as specified (all location tokens on the stated line) | 281 | 229 | 94 | 2379 / 5181 / 3916 |
| RELAXED normalisation | 408 | 102 | 94 | — |
| ALIASED | 448 | 62 | 94 | — |
| Policy on RELAXED | 469 | 40 | 95 | — |
| Policy on ALIASED (headline) | 505 | 4 | 95 | 7502 / 54 / 3920 of 11476 |

Headline: 83.6% of distinct strings and 65.4% of occurrences fully placeable; 34.2% of occurrences line-wide by construction. Policy contract: only tokens in the stated line's own PRIMARY sentence count (sentences containing replacement bus / tickets / 'use ...' / 'will not operate' / 'are running' / 'continue to operate' / timetable times, or naming another line or operator, are ignored); SECTION/ROUTE/DIRECTION tokens need >=1 on-line resolution (alternative endpoints 'A / B' keep the on-line one); CAUSE/AT tokens ('fire alert at X') may resolve to any gazetteer station because lines pass through stations they do not serve (Neasden/Kilburn for Metropolitan, South Kensington for H&C, Royal Oak/Westbourne Park for District/Met, Victoria for Windrush, Earl's Court for Circle). The 4 residual PARTIALs: 3x 'event at Notting Hill' (mildmay, not a station) and 1 Windrush string quoting the Mildmay closure 'between Camden Road and Stratford' (needs per-clause line scoping). NONE=95 = 94 no-location strings + 1 Suffragette 'the 0533 and 0548 trains from Barking Riverside to Gospel Oak will not run' (timetable-scoped, correctly line-wide). 4 strings are published under both jubilee and metropolitan with per-line clauses ('METROPOLITAN LINE: No service between ... JUBILEE LINE: No service between ...'); they classify FULL only because the line-id union was used. The dominant strict failure is "at <cause station>" on a line that passes without stopping: 49 token instances.

### 3.3 Template inventory (B2; pattern, distinct count, example)

| Pattern | n | Example |
|---|---|---|
| service will resume later this morning | 19 | Bakerloo Line: Service will resume later this morning. (occ 1410) |
| minor delays due to train cancellations | 13 | Central Line: Minor delays due to train cancellations. (occ 1384) |
| minor delays between <STN> and <STN> due to train cancellations good service on the rest of the line | 12 | Windrush Line: Minor delays between Highbury & Islington and West Croydon due to train cancellations. GOOD SERVICE on the rest of the line. (occ 55) |
| minor delays due to an earlier fire alert at <STN> | 10 | Jubilee Line: Minor delays due to an earlier fire alert at Willesden Green. (occ 74) |
| minor delays between <STN> and <STN> while we fix a signal failure at <STN> good service on the rest of the line | 10 | District Line: Minor delays between High Street Kensington and Edgware Road while we fix a signal failure at Westbourne Park. GOOD SERVICE on the rest of the line. (occ 33) |
| <empty reason: line-name prefix only> | 6 | Liberty Line: (occ 66) |
| minor delays due to an earlier signal failure at <STN> | 6 | Circle Line: Minor delays due to an earlier signal failure at Royal Oak. (occ 58) |
| severe delays due to train cancellations | 4 | Hammersmith and City Line: Severe delays due to train cancellations. (occ 143) |
| no service between <STN> and <STN> and severe delays on the rest of the line while we respond to a fire alert at <STN> | 4 | Jubilee Line: No service between West Hampstead and Stanmore and SEVERE DELAYS on the rest of the line while we respond to a fire alert at Wembley Park. (occ 16) |
| minor delays between <STN> and <STN> due to an earlier faulty train at <STN> good service on the rest of the line | 4 | Metropolitan Line: Minor delays between Harrow-on-the-Hill and Uxbridge due to an earlier faulty train at Rayners Lane. GOOD SERVICE on the rest of the line. (occ 13) |
| the emergency services are responding to a large fire near the railway at <STN> ... <LINE>: no service between <STN> and <STN> and severe delays on the rest of the line <LINE>: no service between <STN> and <STN> and severe delays on the rest of the line | 3 | The emergency services are responding to a large fire near the railway at Neasden. Until it is made safe, Jubilee and Metropolitan line services are unable to run through the area. ... METROPOLITAN LINE: No service between Harrow-on-the-Hill and Aldgate and SEVERE DELAYS on the rest of the line. JUBILEE LINE: No service between Wembley Park and Willesden Green and severe delays on the rest of the line. (occ 129, published under both jubilee and metropolitan) |
| no service between <STN> and <STN> and severe delays on the rest of the line while emergency services respond to a large fire near the railway at <STN> tickets will be accepted on london buses, <LINE>, <LINE>, <LINE>, c2c and thameslink services service is not expected to resume fully until early afternoon on <DAY>, <DATE> please check before you travel | 3 | Jubilee Line: No service between Wembley Park and Willesden Green and SEVERE DELAYS on the rest of the line while emergency services respond to a large fire near the railway at Neasden. Tickets will be accepted on London Buses, DLR, Elizabeth line, Mildmay line, C2C and Thameslink services. ... (occ 110) |
| service will resume later this morning there will be no service between <STN> and <STN> and between <STN> and <STN> due to planned engineering work | 3 | London Tramlink: Service will resume later this morning. There will be no service between Reeves Corner and East Croydon and between Arena and Elmers End due to planned engineering work. (occ 35) |
| service will resume later this morning there will be no service between <STN> and <STN> due to planned engineering work | 3 | Docklands Light Railway: Service will resume later this morning. There will be no service between Tower Gateway and Shadwell due to planned engineering work (occ 30) |
| minor delays due to an earlier customer incident | 3 | Central Line: Minor delays due to an earlier customer incident. (occ 26) |
| severe delays due to an earlier fire alert at <STN> london buses are accepting tickets via any reasonable route | 3 | Jubilee Line: Severe delays due to an earlier fire alert at Willesden Green. London Buses are accepting tickets via any reasonable route. (occ 23) |
| minor delays due to an earlier points failure at <STN> | 3 | Circle Line: Minor delays due to an earlier points failure at King's Cross St Pancras. (occ 22) |
| severe delays between <STN> and <STN> due to train cancellations good service on the rest of the line | 3 | Windrush Line: Severe delays between Sydenham and West Croydon due to train cancellations. GOOD SERVICE on the rest of the line. (occ 22) |
| minor delays between <STN> and <STN> while we fix a track fault at <STN> good service on the rest of the line | 3 | Mildmay Line: Minor delays between Willesden Junction and Clapham Junction while we fix a track fault at Shepherd's Bush. GOOD SERVICE on the rest of the line. (occ 17) |
| minor delays due to an earlier faulty train at <STN> | 3 | Bakerloo Line: Minor delays due to an earlier faulty train at Lambeth North. (occ 11) |
| no service between <STN> and <STN> while we respond to a fire alert at <STN> good service on the rest of the line | 3 | Circle Line: No service between Hammersmith and Goldhawk Road while we respond to a fire alert at Hammersmith. GOOD SERVICE on the rest of the line. (occ 6) |
| <LINE>: <DATE-RANGE>, no service between <STN> and <STN> [/ <STN>]. replacement bus service <ROUTE> operates between <STN> and <STN> via <STN-LIST>. use ... between <STN> and <STN> ... | 7 | NORTHERN LINE: Saturday 29 August, from 0330 (including Night Tube), and all day Sunday 30 and Bank Holiday Monday 31 August, no service between Archway and High Barnet / Mill Hill East. Replacement bus service NL3 operates between Archway and High Barnet via Highgate, East Finchley, ... (occ 316; 7 replacement-bus strings totalling ~1100 occ, section only in the first sentence) |
| service will resume at <TIME> on <DAY> | 2 | Waterloo and City Line: Service will resume at 06:00 on Tuesday. (occ 39) |
| no service between <STN> and <STN> and minor delays between <STN> and <STN> station via <STN> while we fix a signal failure at <STN> tickets being accepted by london buses | 2 | Northern Line: No service between Colindale and Edgware and MINOR DELAYS between Colindale and Battersea Power Station via Charing Cross while we fix a signal failure at Edgware. Tickets being accepted by London Buses. (occ 32) |
| <severity> between <STN> and <STN> <eastbound|westbound|northbound|southbound> only [due to|while we fix] <cause> at <STN> good service on the rest of the line | 22 | Piccadilly Line: Minor delays between Acton Town and Uxbridge eastbound only due to train cancellations. GOOD SERVICE on the rest of the line. (22 distinct phrases carry a direction qualifier; 57 strings) |

### 3.4 Structural features a deterministic parser must handle (B2)

- "and SEVERE DELAYS on the rest of the line" / 'all other routes' / 'on the entire line' in 359 strings — two severities per string (e.g. 'No service between X and Y and SEVERE DELAYS on the rest of the line', 'MINOR DELAYS on the rest of the line due to train cancellations'); the feed's single status per entry does not capture the split.
- Multi-section in 98 strings: 'between A and B and between C and D' (Met: Harrow-on-the-Hill–Aldgate + Moor Park–Watford); 'between A and B, and C and D' (District: Fulham Broadway–Wimbledon, and Earl's Court–Kensington (Olympia)); two severities with two sections ('No service between Colindale and Edgware and MINOR DELAYS between Colindale and Battersea Power Station via Charing Cross'); multi-line strings with per-line clauses (Neasden fire, 4 strings under both ids).
- Direction qualifiers in 57 strings / 22 distinct phrases: 'eastbound only', 'westbound only', 'northbound/southbound only', 'clockwise only' (Circle), and a CAPITALISED suffix glued to the station name ('Leytonstone Eastbound only', 'Tower Hill Eastbound', 'Baker Street Southbound', 'SEVERE DELAYS Westbound only'); one string carries opposite severities per direction ('SEVERE DELAYS between Watford and Harrow-on-the-Hill Northbound only and MINOR DELAYS ... Southbound only').
- 'via': 99 strings, only 22 routing ('via <STN>'): Circle 'between Aldgate and Edgware Road via Victoria' / 'via High Street Kensington'; Northern 'via Charing Cross' / 'via Bank'; Central 'via Newbury Park' / 'via Grange Hill' (Hainault loop); District 'via Parsons Green...' inside replacement-bus text; Weaver 'diverted via Tottenham Hale' (Greater Anglia, secondary); the other 77 are 'accepting tickets via any reasonable route'.
- Dated planned closures: 33 strings (Part Closure, Planned Closure, Part Suspended, Service Closed, Reduced Service) with weekday+date ranges ('Saturday 29 August, from 0330 (including Night Tube), and all day Sunday 30 and Bank Holiday Monday 31 August'), recurring windows ('From Thursday 6 until Sunday 30 August ... On Mondays to Fridays, no service before 0700 and after 1930'), 'after 2245 each evening', standing text (Waterloo & City 'service operates 06:00 until 00:30, Monday to Friday only', 352 occ). Section still in the first sentence; string persists all day (tram closure strings = 1702 occ).
- Replacement bus: 7 strings (~1100 occ) — 'Replacement bus service NL3 operates between Archway and High Barnet via Highgate, East Finchley, ... (Ballards Lane), Woodside Park (North Finchley High Road)'; 'Use London Buses route 382 between Finchley Central and Mill Hill East and Night Bus N20 between Archway and High Barnet'; 'Trains will continue to operate between Acton Town and Heathrow' (the RUNNING part). Must be sentence-scoped out.
- Ticket-acceptance sentences in 244 strings naming other operators (Thameslink 55, Greater Anglia 25, C2C, Chiltern, Southeastern, 'Greater Anglia (Liverpool Street - Harlow Town)').
- Stations not on the stated line (after aliasing): SECTION 11 token instances, all in other-line / replacement-bus / other-operator sentences ('There will also be no WINDRUSH LINE service between Highbury & Islington and Dalston Junction' in a Mildmay string; 'additional replacement bus service between London Bridge and Tulse Hill' (Southern); 'Chiltern railway services are running between Amersham and Aylesbury') except one Windrush string quoting the Mildmay closure; CAUSE/AT 49 instances ('fire alert at Neasden/Kilburn' on Metropolitan, 'at South Kensington' on H&C, 'at Royal Oak'/'at Westbourne Park' on Metropolitan/District, 'at Victoria' on Windrush, 'at Earl's Court' on Circle, 'at Stonebridge Park' on Mildmay); MENTION 7 ('use the Bakerloo line or Lioness line to Wembley Central station').
- Bare 'X to Y' sections without 'from' (4 strings): 'Severe delays Baker Street to Aldgate and MINOR DELAYS between ...', 'Edgware Road to High Street Kensington'.
- Feed typos/truncations: 'Harrow-on-the- Hill' (116 occ) and 'Harrow-on-the Hill', 'West Ruilsip', 'Seven Sister', 'Baker street', 'Wembley park', 'Camden Town Golders Green' (missing 'and'), 'Earls Court' vs 'Earl's Court', double spaces ('between  Oakwood'), '. .' punctuation, 'due to an earlier to a fire alert'. A2 also saw 'no service between  Wembley Park and West Hampstead' (double space), 'Baker street' vs 'Baker Street' for the same incident, and 'GOOOD SERVICE'.
- Non-station places in location slots: 'Wembley Arena' (venue, 274 occ), 'Notting Hill' ('crowding during an event at Notting Hill', 40 occ), 'Morden Depot', 'Aylesbury' (off map, Chiltern, 71 occ), 'Neasden' as 'near the railway at Neasden'.

### 3.5 A2's 6-day sample (2026-08-28..09-02)

216 distinct `reason` strings: 147/216 contain 'between', 24/216 'via', 9/216 a real 'X/Y' multi-destination slash, 0/216 the literal phrase 'change at' (the task's 'changes at X' pattern not observed — unverified/not-yet-seen). Observed prefixes: 'Central Line:', 'LONDON TRAMS:', 'NORTHERN LINE:', 'Windrush Line:', 'Hammersmith and City Line:'. Observed shapes: 'LINE: No service between X and Y while we fix a Z at W. SEVERITY on the rest of the line.', 'Minor delays between X and Y [direction] only due to ...', 'Severe delays between X and Y/Z ... and between A and B via C due to ...'. 'via' has two meanings: (a) branch disambiguation on the line ('MINOR DELAYS between Camden Town and Battersea Power Station via Charing Cross' — resolvable against `data/branches/northern.json`), (b) replacement-bus road routing ('Replacement bus service NL3 operates between Archway and High Barnet via Highgate, East Finchley, Finchley Central...').

### 3.6 Darwin nrccMessages template shapes (B3)

'Trains running between X and Y [/ Y2 / Y3] may be ...' (3/7); 'Trains [running] through X [and Y] may be ...' (2/7); 'X to Y railway is open ...' (1/7, POSITIVE notice); 'A reduced <TOC> service is in operation on some routes' (1/7, no place). 'through X' is a point, not a segment. Wordings 'No service between', 'Buses replace trains between', 'Lines are blocked' were not observed — unverified.

---

## 4 Name-resolution problems (duplicate names, aliases, loop and fork lines)

### 4.1 Gazetteer inventory (A2, B1, B2, A4)

- TfL: `data/stations/*.json` 25 files, 676 rows, 537 distinct NaPTAN ids (940G 358, 910G 153, 930G 26), 496 distinct names. 25 lines, 242 total branches (~121 unique physical fragments), 1313 inter-stop segment entries in `data/branches/*.json`.
- NR: `data/nr/stations.json` 431 stations, all `crs` distinct AND all names distinct (zero same-string duplicates); no apostrophes in names.
- Practical gazetteer keyed by `(lineId, normalized bare name) -> NaPTAN id`: ~496 TfL entries + 431 NR entries.
- TfL and NR name sets overlap exactly (case-sensitive) on 158 names (Stratford, Highbury & Islington, Wimbledon, West Croydon, …) — a name may need to resolve to a TfL id or an NR crs depending on which upstream produced the notice. `data/nr/stations.json` is CRS-keyed, a different id space from 910G NaPTAN; a CRS<->910G bridge is unverified to exist in the repo.

### 4.2 Duplicate names / same name, different id

- 39 names occur under 2+ DIFFERENT NaPTAN ids (A2, B1). Examples: Paddington 940GZZLUPAC vs 940GZZLUPAH 'Paddington (H&C Line)-Underground' vs 910GPADTLL (elizabeth); Edgware Road 940GZZLUERB '(Bakerloo)' vs 940GZZLUERC '(Circle Line)'; Hammersmith 940GZZLUHSC '(H&C Line)' vs 940GZZLUHSD '(Dist&Picc Line)'; Bank 940GZZLUBNK (central/northern/waterloo-city) vs 940GZZDLBNK (dlr); Canary Wharf 940GZZDLCAN / 910GCANWHRF / 940GZZLUCYF; Stratford 940GZZLUSTD / 940GZZDLSTD / 910GSTFD; West Ham; Whitechapel THREE ids 940GZZLUWPL, 910GWCHAPXR, 910GWCHAPEL; Liverpool Street 940GZZLULVT / 910GLIVSTLL / 910GLIVST; Ealing Broadway; Farringdon; Bond Street; TCR; Barking; Upminster; Willesden Junction; Canning Town. Clapham Junction has two ids even within mildmay (910GCLPHMJC/910GCLPHMJ1). Elizabeth line planned closure listed both 910GPADTLL 'Paddington' and 910GPADTON 'London Paddington', both in `data/stations/elizabeth.json`.
- B2: 78 resolved names map to different station ids on different lines (183 such names in the gazetteer).
- None are genuinely different places; scoping lookup to the notice's own `lineId` (`data/stations/<lineId>.json`) resolves them — each line's file has at most one row per bare name in the 3 checked cases (not separately verified for every line).

### 4.3 Special characters and naming quirks

- Over 496 distinct TfL names: 12 contain '&' (e.g. Harrow & Wealdstone — genuine, must NOT be treated as separator); 16 contain '(' (disambiguators plus 'Queens Park (London)', 'Richmond (London)', 'Kensington (Olympia)'); 0 contain '/'; 3 contain '-' (Bromley-by-Bow, Harrow-on-the-Hill, 'Paddington (H&C Line)-Underground'); 0 contain 'via'. B1: 12 parenthetical names, 22 names with & / St. / apostrophe.
- '/' never appears in a baked name, so every '/' in reason text is a genuine alternative separator (e.g. 'Ealing Broadway/West Ruislip').
- All 39 `tram.json` names end ' Tram Stop'. Rail names: 'London Liverpool Street', 'London Euston', 'Stratford (London)', 'Richmond (London)', 'Cambridge Heath (London)', 'Queens Park (London)'. Tube disambiguators: 'Hammersmith (H&C Line)' / 'Hammersmith (Dist&Picc Line)' / 'Edgware Road (Circle Line)' / 'Edgware Road (Bakerloo)' / 'Shepherd's Bush (Central)' / 'Paddington (H&C Line)-Underground'; 'New Cross ELL' on windrush; 'Custom House (for ExCel)', 'Cutty Sark (for Maritime Greenwich)'; curly apostrophe in 'St Mary’s Wandsworth Pier'; Battersea Park absent from `windrush.json` (NR only).
- NR: 9+ disambiguating suffixes (Ashford Surrey, Hayes (Kent), Cambridge Heath (London), Queens Park (London), Richmond (London), St James Street (London), Northfleet - Cooper Arms, Swanscombe - George & Dragon, Burnham (Berks), Langley (Berks); A4: 'Queens Park (London)', 'Stratford (London)', 'Sutton (London)') plus 'London ' prefix on termini; exactly 9 'London X' NR names match a bare TfL name 'X' after stripping the prefix.
- TfL `affectedStops.commonName` carries ' Underground Station' / ' Rail Station' suffixes — match by id, not name.
- Line-name prefix: `manifest.json` `name` is what reason text prefixes with; 'Hammersmith and City' spelled with 'and' in prose vs '&' in the manifest; strip trailing ' Line'/' LINE', normalise '&'<->'and'. 'Victoria line' / 'Waterloo & City line' / 'Hammersmith & City line' must be masked before station matching.

### 4.4 Gazetteer misses and required alias table (B2)

Unmatched phrases under strict matching (48): Edgware Road; Hammersmith; Reeves Corner; High Barnet / Mill Hill East; King's Cross St Pancras; Arena; Aldgate / Uxbridge; Earls Court; Shepherd's Bush; Harrow-on-the- Hill; Enfield Town / Cheshunt; Ealing Broadway / Richmond; Baker (street); Totteridge & Whetstone (Whetstone High Road); Wimbledon / Richmond / Ealing Broadway; Waddon Marsh; Wembley (park); Church Street; Therapia Lane; Ealing Broadway / Richmond / Edgware Road / Wimbledon; Clapham Junction / Battersea Park; Crystal Palace / West Croydon; Ealing Broadway / West Ruislip; Epping / Hainault (via Newbury Park); Harrow-on-the Hill; Wandle Park; Avenue Road; Harrington Road; Uxbridge / Aldgate; Wimbledon / Edgware Road; Bank / Tower Gateway; Richmond / Wimbledon; Heathrow Terminals; Heathrow Airport; Terminal 5; Heathrow Terminals / Reading; Heathrow; West Ruilsip; King's Cross; Seven Sister; Heathrow Terminal 2; Morden Depot; Camden Town Golders Green; Dalston; Harrow; Wembley Arena; Notting Hill; Aylesbury.

Aliases needed:

| Seen | Canonical / rule |
|---|---|
| Edgware Road | Edgware Road (Circle Line) 940GZZLUERC / Edgware Road (Bakerloo) 940GZZLUERB — strip parenthetical; stated line picks id |
| Hammersmith | Hammersmith (H&C Line) 940GZZLUHSC / Hammersmith (Dist&Picc Line) 940GZZLUHSD — strip parenthetical; stated line picks id |
| any tram name (Reeves Corner, Arena, Waddon Marsh, Church Street, Therapia Lane, Wandle Park, Avenue Road, Harrington Road, East Croydon, Elmers End) | `<name> Tram Stop` — strip ' Tram Stop' on all 39 tram.json names |
| Earls Court | Earl's Court — fold apostrophes |
| King's Cross St Pancras | King's Cross St. Pancras — fold periods |
| King's Cross | King's Cross St. Pancras — hand alias |
| Shepherd's Bush | Shepherd's Bush (Central) / Shepherds Bush (mildmay) — apostrophe + parenthetical |
| Harrow-on-the- Hill / Harrow-on-the Hill / Harrow | Harrow-on-the-Hill — fold hyphens to spaces (feed typo, 126 occ); bare 'Harrow' = line-scoped unique prefix |
| Baker street / Wembley park | Baker Street / Wembley Park — extend phrase with following lowercase words when the extension is a gazetteer name |
| Stratford / Richmond / Liverpool Street / Euston / Cambridge Heath / Queens Park (rail lines) | Stratford (London) / Richmond (London) / London Liverpool Street / London Euston / Cambridge Heath (London) / Queens Park (London) — strip '(London)' and 'London ' only when the remainder is itself a station name (London Bridge / London Fields stay) |
| High Barnet / Mill Hill East, Bank / Tower Gateway, Enfield Town / Cheshunt, Crystal Palace / West Croydon, Ealing Broadway / West Ruislip, Aldgate / Uxbridge, Richmond / Wimbledon, Ealing Broadway / Richmond / Edgware Road / Wimbledon | split on ' / ' — alternative branch endpoints; each part resolves separately |
| Clapham Junction / Battersea Park | Clapham Junction (windrush) — Battersea Park is NR-only; keep the on-line part |
| Totteridge & Whetstone (Whetstone High Road) / Epping / Hainault (via Newbury Park) | Totteridge & Whetstone / Epping + Hainault — strip trailing parenthetical |
| Heathrow / Heathrow Terminals / Heathrow Airport / Heathrow Terminals / Reading | branch set {Heathrow Terminals 2 & 3, Heathrow Terminal 4, Heathrow Terminal 5} (+ Reading) — hand alias; 'Heathrow' alone = 369 occ ('between Acton Town and Heathrow') |
| Terminal 5 | Heathrow Terminal 5 — hand alias |
| Heathrow Terminal 2 | Heathrow Terminals 2 & 3 — hand alias |
| New Cross | New Cross ELL (windrush.json id 910GNWCRELL per name; verified name only) — hand alias, also an NR station |
| West Ruilsip / Seven Sister | West Ruislip / Seven Sisters — Damerau-Levenshtein<=1 on names >=8 chars with a unique candidate |
| Dalston | Dalston Junction — unique name-prefix on windrush; Dalston Kingsland on mildmay |
| Camden Town Golders Green | Camden Town (feed dropped 'and'; Golders Green lost) — phrase-prefix rescue, lossy |
| Morden Depot | Morden — depot, not a station; judgement call |
| Wembley Arena | NOT A STATION (advice text, 274 occ) — leave unresolved |
| Notting Hill | NOT A STATION ('event at Notting Hill', 40 occ) — leave unresolved; do not guess Notting Hill Gate |
| Aylesbury | OFF MAP (Chiltern, 71 occ, secondary sentence) — leave unresolved |

Bus prose adds 'ROUTE 200' / 'ROUTES 41 230 N41' route tokens and quoted stop names ('Watney Market' (K)) — no bus-stop gazetteer exists (see 5.1).

### 4.5 Existing normaliser gap (A2)

`normStation()` (`frontend/src/realtime/position-inference.ts:50-60`) lowercases, strips apostrophes, flattens '.', '-', '_', '/' to spaces, strips trailing 'Underground/DLR/Rail Station' and 'Platform N', collapses punctuation/whitespace — but `normStation('Edgware Road (Circle Line)')` -> 'edgware road circle line' while `normStation('Edgware Road')` -> 'edgware road' (the `[^a-z0-9 ]` step turns parentheses into spaces rather than deleting the group). A second step (strip trailing ' (...)' group, or resolve strictly within the notice's lineId file) is required; nothing in the codebase does it.

### 4.6 Loop and fork lines (A2, B1)

- TfL's Route/Sequence splits a line into `branchId` fragments at every fork/merge; `bake-routes.mjs` stores each as-is. Verified: circle = 4 branches (2 outbound + 2 inbound, split at 'Edgware Road (Circle Line)', stop counts 10,28,28,10 — two linear chains from breakpoint back to breakpoint, not a ring); district = 14 (Ealing Broadway/Richmond/Wimbledon/Kensington(Olympia) west forks converging at Earl's Court, single Upminster trunk east); northern = 20; dlr = 26 (Bank->Shadwell and Tower Gateway->Shadwell as separate 2-stop branches converging at Shadwell); weaver = 10 (Edmonton Green->Cheshunt and Edmonton Green->Enfield Town — the Enfield Town/Cheshunt fork is on weaver, NOT windrush); metropolitan = 17 (asymmetric 10 outbound / 7 inbound).
- Same-branch A-to-B: find idx(A)/idx(B) in `branch.stops`, concat `branch.segments[min..max-1]`, reverse if needed (mirror of `subPolyline()` on discrete segments).
- Pairs not sharing a branch (forks, Circle breakpoint): NO per-line graph/pathing utility exists for TfL; a new per-line Dijkstra/BFS over all branches, modelled on `NrRailGraph`, is required. Underestimating this fails on District (14), Northern (20), DLR (26), Metropolitan (17), and any Circle pair straddling Edgware Road.
- 'via' disambiguation needed for: Circle 'via Victoria' / 'via High Street Kensington' (which half of the loop); Northern 'via Charing Cross' / 'via Bank'; Central 'via Newbury Park' / 'via Grange Hill' (Hainault loop).
- B1 structured alternative: `isEntireRouteSection=false` sequences are contiguous ordinal slices that map straight onto baked track segments, avoiding the graph problem when populated.

### 4.7 Keyword-unanchored false positives (B2)

'Bank' in 'Bank Holiday Monday' / 'bank/public holidays' (3 strings), tram 'Arena' inside 'Wembley Arena' (6 strings), 'Notting Hill Gate' inside 'Notting Hill Gate carnival', 'Loughton' in 'travelling beyond Loughton', 'Liverpool Street' inside 'Greater Anglia (Liverpool Street - Harlow Town)'; 23 keyword-unanchored contexts in total. Keyword-anchored extraction avoids all of it.

### 4.8 NR name hazards (A4, B3)

- Substring collisions: 'Croydon' inside 'West Croydon'/'East Croydon' — longest-match-first / word-boundary matching required.
- HTML must be stripped and entities decoded before matching ('Highbury &amp; Islington').
- Slash alternatives ('Barnham / Bognor Regis / Portsmouth Harbour', 'Clapham Junction / West Croydon') expand one message into several segments.
- Out-of-bbox names (9/14 in B3's sample) have NO mapping; fail closed to the board's own station.
- The 9 parenthesised NR names need both full and bare aliases; no in-box bare-name collisions (verified) but the parenthetical existed to avoid an out-of-box same-name station.

### 4.9 Route/Sequence and HUB ids (B1)

`stations[].id`, `parentId`, `topMostParentId` use HUB ids (11/29 windrush, 12/52 northern) absent from `data/stations`; `stopPoint[].id`/`stationId` match 100%. `affectedStops` and route sequences never used HUB or 9400 platform ids in 113 observed stops; all lat/lon are 0.

---

## 5 Bus and National Rail feasibility as measured

### 5.1 Bus (A3, B1)

- No bus-stop NaPTAN/ATCO -> {name, coordinate} lookup exists anywhere in backend, frontend or `data/`. `data/stations/*.json` covers rail modes only (`bake-routes.mjs:21-49`). `scripts/fetch-bus-prior.mjs` parses `StopPointRef`/`AtcoCode` (250-260) but discards the ref at `stops.push(loc)` (316-320); no `CommonName` parsed. `learn-bus-routes.mjs:562-582` uses `prior.stops` only as geometric anchors (40 m radius, pull 0.5); learned files `{key, poly, quality}` have no stops.
- Live BODS feed has no stop identity (`bods-client.ts:14-42`, 76-106). `bus-filter.ts` is line-number-only (~600-700 live routes).
- An `affectedStops` list for route N CANNOT currently be drawn on N's learned polyline: no NaPTAN->coordinate lookup, and no stop markers on the polyline. It COULD be, cheaply, because nearest-point-on-polyline math exists twice: `route-projection.ts:51 buildRouteIndex(poly)`, `:233 slicePolyline(poly, sA, sB)` (used at `diversion-events.ts:602-605`), plus the stop-anchor pattern in `learn-bus-routes.mjs:562-582`.
- A TfL disruption CAN be joined to a diversion-detector event today, but only via a pure spatial join (`matchTfl`, `TFL_MATCH_DIST_M=250` m, against the HIGH-confidence bracket MIDPOINT on the learned polyline) against the ROAD disruption feed (`/Road/all/Disruption`, archived every 6 h, fields `{id, cat, sev, loc, com, start, end, pt}`), not a bus-service feed. Only shared field is coordinates; the feed is used as geometry ground truth, not rider-facing text.
- Missing pieces: (1) bus-stop gazetteer; (2) any call to bus-mode line status / bus disruption (`status-recorder.ts:19` excludes 'bus'); (3) stop-ordinal/segment mapping on learned polylines. Cheapest path: change `stops.push(loc)` to `{ref, loc}` + `firstTag(sp.body,'CommonName')` in `fetch-bus-prior.mjs` (bake-time only; prior output 11 MB / ~1736 files never served) — zero runtime/egress cost. A full bulk bus-stop gazetteer analogous to `data/stations/` (160 KB for ~270 rail stops) would scale ~15,000-20,000x more entries (unverified; general public-domain figure ~19,000 TfL bus StopPoints) — likely a few MB, one-time bake.
- Live TfL feeds measured (B1): bus `detail=true` unusable (10.4 MB raw / 681 KB gz, timeout at 20 s uncompressed, 387/387 whole-route, 3/217 with affectedStops). Usable: `/Line/Mode/bus/Status` no-detail (745 KB / 41 KB gz; 217 'Special Service' statuses with reason+validityPeriods+category keyed by line id) + `/StopPoint/Mode/bus/Disruption` (124 KB / 9 KB gz; 303 stop closures keyed by 490… atcoCode with from/to dates). `/Line/Mode/bus/Disruption` has no route id (prose only). Bus statuses use only severity 0 'Special Service'; `closureText` undefined.
- Budget: a bus-mode status poll would draw on the SAME shared 60 req/min `tflBudget` (`constants.ts:8,11`; `app.ts:249` per A3) — the per-upstream-budget rationale ("so they can never starve TfL calls") does not apply since it is still TfL; a single bulk call (not per-route) with its own `TtlCache` (like `lineStatusCache`) is cheap per request but must be compacted server-side (745 KB raw per fetch).

### 5.2 National Rail / Darwin (A4, B3, A2)

- `nrccMessages` (station-level, HTML `Value` only) and per-service `delayReason`/`cancelReason`/`isCancelled`/`futureDelay` are already in the board response fetched for the 17 hubs and are discarded by `darwin-client.ts` (`RdmBoard` 62-67, normaliser 85-114/115). Surfacing them is a pure parsing extension: ZERO new upstream calls, ZERO new Darwin budget; ~1-1.5 KB extra per board.
- Coverage: messages only for the 17 CRS queried (~4% of 431 stations), but hub messages already name other stations (Peckham Rye, Amberley, Lewes, Highbury & Islington, Clapham Junction, West Croydon). Whether 17 hubs give near-complete London NR coverage is unverified.
- Budget arithmetic (derived, not measured): 17 hubs at 45 s TTL bounds max useful upstream rate at ~17/45s*60 ≈ 22.7 calls/min regardless of client count -> ~40 − 22.7 ≈ 17 calls/min headroom (backend sampler revisits a hub every 255 s = 17×15 s; one frontend tab every 68 s = 17×4 s; both slower than the 45 s TTL). Full 431-station sweep = 431/40 ≈ 10.8 min on the whole budget and would starve existing polling — not recommended without a dedicated second `RateBudget` (convention: `adsbBudget`/`adsbdbBudget`/`eaBudget` at `app.ts:267-268,282`).
- Resolver needs: name->CRS gazetteer over 431 entries (no dup names, no apostrophes, 9 parentheticals, longest-match-first); HTML/entity stripping; multi-hop Dijkstra via `NrRailGraph.railPath` (`nr-inference.ts:195-240`) since 579 edges average ~1.3 per station and NRCC text spans routes; fail-closed for any name outside the 431-node graph and the 26-entry `NR_GATEWAYS` table.
- Structured-first for NR = per-calling-point `isCancelled` -> segment between consecutive cancelled points on the baked graph; on the 3 cancelled EUS services only 1/6, 4/12, 3/13 cancelled calling points fall inside the graph. `cancelReason`/`delayReason` never contain a place. `affectedByDiversion`/`rerouteDelay` were false/0 on all 1267 calling points; `adhocAlerts` never appeared.
- Measured attachability of the 7 distinct messages: fully 2/7, partial 1/7, none 3/7, no place 1/7. Positive notices ('railway is open') share the 'X to Y' shape and need a polarity check. Messages persist for days (slugs dated 20260813, 20260828 vs sample 20260902) with no timestamp/expiry in the JSON.
- `docs/OVERGROUND_DARWIN_PLAN.md` (untracked, unimplemented) will also grow HUBS and pressure the same `darwinBudget`/`nrBoardCache`.

---

## 6 Reusable code

| Symbol | Path | Use |
|---|---|---|
| `registerProxyRoute` | `backend/src/routes/proxy-route.ts:71-138` | Cache/budget/`x-cache`/error-redaction plumbing for a new `/api/disruptions` route; must be deviated from (or shaped inside the fetch callback) to avoid verbatim pass-through on 200. |
| `singleParamKey` / `LINE_IDS_PATTERN` | `backend/src/routes/stop-arrivals.ts:19`, `proxy-route.ts:52-60` | Validate a `lines`/`modes` query param. |
| `compactStatus` | `backend/src/tube-status-recorder.ts:51-73` (A1/A5) / `:178` (B1) | The only existing server-side shaping of a TfL status body into an allow-listed contract `{s,d,r}`. |
| `compactRoutes()` / `compactDisruption()` / `TflAffectedRoute` | `backend/src/tube-status-recorder.ts:100-169` (A2) / `:156-171` (B1) | Already parses `routeSectionNaptanEntrySequence` into ordered NaPTAN arrays and dedups `affectedStops` — the priority-1 structured path. |
| `fetchLineStatusByModes(modes, appKey, timeoutMs, withDetail)` | `backend/src/tfl-client.ts:53-60` | Supports `detail=true`; live `/api/line-status` calls with `withDetail=false` (larger payload per comment at `tfl-client.ts:47-52`). |
| `fetchTfl` params | `backend/src/tfl-client.ts:99-115` | Add `detail: 'true'` or date-window paths without new plumbing. |
| `findLiftDisruption` | `frontend/src/ui/station-popup.ts:186-200` | Production precedent for deterministic station-name/naptanId matching (prefix, substring-in-name, substring-in-message-prefix). |
| `truncate` / `injectPopupStyles` / `ENRICH_STYLE_ID` | `frontend/src/ui/station-popup.ts:26`, `:35` | Text capping (`STATUS_REASON_MAX_CHARS=140`) and safe one-time CSS injection. |
| `TtlCache` / `RateBudget` | `backend/src/cache.ts`, `backend/src/rate-budget.ts:6-24` | Instantiate new ones for the disruptions route. |
| `data/branches/<lineId>.json` `branch.stops` + `segments` | `data/branches/*.json` | Ordered stops + parallel per-hop polylines for same-branch A-to-B slicing. |
| `data/manifest.json` `line.name` | `data/manifest.json` | Build line-name-prefix -> lineId map ('&'<->'and', strip ' Line'). |
| `NrRailGraph` / `railPath(a, b)` | `backend/src/shared/nr-inference.ts:160-241`; frontend closure `frontend/src/realtime/nr-trains.ts:243` | Dijkstra over CRS nodes returning real-track polyline, `MAX_PATH_M=60_000`, `PATH_CACHE_MAX=300`; keep both copies in sync. |
| `NR_GATEWAYS` / `NR_GATEWAY_SNAP` | `nr-inference.ts:66-108` | Only out-of-box -> in-box mapping (26 entries). |
| `makeCachedNrBoardFetcher` | `backend/src/nr-sampler.ts:81-106` | Read messages through the same `nrBoardCache`/`darwinBudget`. |
| `NrStation` / `NrSegment` | `nr-inference.ts:18-30`; `nr-trains.ts:27-39` | Canonical NR data shapes. |
| `normStation()` | `frontend/src/realtime/position-inference.ts:50-60` | First-pass tolerant normaliser (needs a parenthetical-stripping second pass). |
| `subPolyline` / `trackSegment` | `scripts/bake-routes.mjs:96-130` | Reference algorithm for arc-length slicing (bake-time only). |
| `buildRouteIndex` / `slicePolyline` | `.claude/worktrees/rollup-attribution/backend/src/route-projection.ts:51`, `:233` (origin/main only) | Snap a stop coordinate onto a learned bus polyline; cut sub-ranges. |
| `matchTfl` / `TflDisruptionPoint` / `parseDisruptionSnapshotLine` | `.claude/worktrees/rollup-attribution/backend/src/diversion-events.ts:628-676` | Template for joining geometry to archived TfL snapshots (spatial, 250 m). |
| MultiLineString wash (`STATUS_COLOR`/`STATUS_OPACITY` + `toFeatures`) | `.claude/worktrees/rollup-attribution/frontend/src/layers/diversions.ts:21-138, 239-256` | Render style for an "affected segment" band with popup. |
| `stopLoc` map | `scripts/fetch-bus-prior.mjs:250-260` | Cheapest bootstrap for a bus-stop gazetteer. |
| `registerPoll` | `frontend/src/util/lifecycle.ts:75` | Poll loop (battery saver aware). |
| `below` | `frontend/src/util/layer-order.ts:15` | Safe `beforeId`. |
| `esc` | `frontend/src/ui/hover-tooltip.ts:10` | Copy the 2-line local escaper (12 files each define their own). |
| `OverlayToggle` | `frontend/src/ui/legend.ts:42` | Legend registration shape. |
| `wireInteractions(map, layerId)` | `frontend/src/layers/road-disruptions.ts:150` | Hover tip + click popup wiring. |
| vitest patterns | `frontend/src/ui/bus-filter.test.ts`, `frontend/src/layers/emergency-classify.test.ts` (maplibre mock + dynamic import); `frontend/src/realtime/interpolator.test.ts` (no mock) | Unit-test surface for a pure parser module. |

A5's proposed minimal new files: `backend/src/disruption-matcher.ts` (pure gazetteer + template parser -> `{stationIds[]|segmentKey|null, lineId, severity, text, confidence}`); `backend/src/routes/disruptions.ts` (GET `/api/disruptions` -> `[{stationId?, segmentKey?, lineId, severity, text}]`); `frontend/src/layers/disruptions.ts` (`DISRUPTIONS_SOURCE_ID='disruptions'` or `'disruptions-stations'`/`'disruptions-segments'`, `DISRUPTIONS_BADGE_LAYER_ID='disruptions-badge'`, `DISRUPTIONS_SEGMENT_LAYER_ID='disruptions-segment'`, `DISRUPTIONS_LAYER_IDS`, `startDisruptions(map)` with `registerPoll(poll, ~120_000)`); `frontend/src/layers/disruptions.test.ts`; wiring in `main.ts` `LAYERS` + `capabilities.ts` boolean (+ optional `station-popup.ts` `footerHtml` `.sp-warn` addition). A1 alternatively suggests the route beside `registerLineStatusRoute` in `stop-arrivals.ts`.

---

## 7 Risks

### 7.1 Egress / payload
- `registerProxyRoute` forwards bodies verbatim on 200 (`proxy-route.ts:118-120`); road-disruptions trims client-side after paying egress. Rail `detail=true` payload is 398,979 B raw (91% `affectedRoutes`), window+detail 668,074 B; bus detail 10.4 MB (timed out at 20 s uncompressed); bus no-detail 745 KB raw per fetch. Origin->CDN egress was 86% of the Railway bill (`app.ts:78-99`). A new endpoint must shape server-side (mirror `compactStatus`), never proxy raw.
- Bus detail=true would blow egress/memory budgets; must never be proxied or cached raw.

### 7.2 Budget
- Every TfL call shares one 60/min `tflBudget` (12 consumers listed in 1.1); `TubeStatusRecorder` runs outside it and does not share a cache key with `/api/line-status`. A second consumer of the recorder's body must be designed deliberately (its `compactStatus` change-detection dedup may need the raw or compact form).
- Darwin: 40/min shared by `/api/nr-board`, `NrSampler`, and per-client 4 s polling; ~17 calls/min theoretical headroom (unverified in prod); `docs/OVERGROUND_DARWIN_PLAN.md` will compete for the same ceiling; a full-station sweep starves existing polling.
- Date-window form requires enumerating line ids (Mode form 404s); list must track `manifest.json` (tram not probed).

### 7.3 Wrong attachment
- Structured fields observed 0% populated in A2's 6-day archive (0 of 3074) vs populated in B1's live probe — the text parser must be treated as primary, well-tested, not an edge-case fallback.
- `isEntireRouteSection=true` sequences look like localisation but mean "whole line" (windrush severeDelays listed 8 entire routes despite a sectional sentence).
- Point incidents (' at <Station>') have no structured station; only prose.
- 39 same-name/different-id stations — resolve within the stated line only; global name lookup could attach to the wrong platform approach track (Paddington/Edgware Road/Hammersmith/Bank/Canary Wharf/Whitechapel).
- 'via' has two meanings (branch vs replacement-bus road routing); 'Replacement bus service … via …' clauses must be excluded from station resolution.
- No TfL per-line graph exists for fork/loop-spanning pairs; Circle pairs straddling Edgware Road need a product decision.
- Keyword-unanchored name matching hits 'Bank Holiday', 'Wembley Arena', 'Notting Hill Gate carnival', 'travelling beyond Loughton', 'Greater Anglia (Liverpool Street - Harlow Town)'.
- Non-station places (Wembley Arena, Notting Hill, Morden Depot, Aylesbury, Neasden-as-place) and cause stations off the stated line (49 instances) must not be guessed.
- NR: `segments.json` encodes one shortest path per adjacent pair, not physical routes — at junctions like Clapham Junction a resolved path may walk a different corridor than the disrupted one; needs manual QA. Out-of-bbox names (9/14) must fail closed. Positive 'railway is open' notices share the 'X to Y' shape. Slash alternatives captured as one name by a naive regex. HTML entities in names ('Highbury &amp; Islington') and XSS if rendered unescaped.
- Bus: road-disruption `loc` text is car-traffic, not rider-facing; `affectedStops`/sequences carry lat:0,lon:0; `stations[].id` HUB ids silently drop 11/29 stations if joined on the wrong field.
- Local `main` lacks diversion-detector/route-projection files; editing `buses.ts`/`bus-filter.ts`/`learn-bus-routes.mjs` at the repo-root path risks working against stale code.
- No shared `esc()`; forgetting a local escaper is an XSS risk (upstream text is untrusted). New badge/segment layers must be inserted into hover-tooltip's ownership chain explicitly.
- Type sync: `backend/src/shared/*` mirrors `frontend/src/realtime/*`; `darwin-client.ts` NrBoard mirrors `nr-trains.ts:49-64` — edit both sides.

### 7.4 Staleness / churn / dedup
- Feed churn: 5 vs 4 disrupted statuses seconds apart; TfL emits one lineStatus per suspended section with one sentence; StopPoint/Disruption re-emits per station — need stable dedup keys (line + closureText + validity fromDate + sorted affectedStops).
- Planned closures arrive with `isNow=false` days ahead (District 5–6 Sept fetched on 2 Sept) — gate on `isNow`/validity; the recorder's Mode-form poll never sees them early.
- Dated/standing strings persist all day (tram closure strings 1702 occ; Waterloo & City standing text 352 occ).
- Darwin messages duplicate across boards (3 of 7 texts on 2 boards) and persist for days without expiry; no severity/category field — severity must be inferred from text, fragile.
- Sample sizes: 5 live rail statuses (3 lines) + 15 window statuses (6 lines) on a quiet Wednesday evening; RealTime affectedStops seen on ONE line (windrush); no tram/DLR/bakerloo/central/jubilee/piccadilly/metropolitan disruption observed. Darwin: 6 boards, 10 message occurrences, 7 distinct texts.
- TfL 404 bodies echo the app_key in `relativeUri` and `message`; keep proxy-route stripping; 200 bodies are not redacted.
- The `.claude/worktrees/rollup-attribution/data/tube-status/*.jsonl` corpus is uncommitted, worktree-local — not a runtime data source.

---

## 8 Open questions and to-verify checklist

### 8.1 Open questions (from sub-reports)
1. Per-mode-group vs per-line-id fetch for a new disruptions endpoint (shared cache key like `/api/arrivals` vs per-line keys like `/api/line-status`)? (A1)
2. Bus disruptions source: `/Line/Mode/bus/Status` sharing `tflBudget`, or a BODS/TfL source not yet identified? Dedicated sub-budget within the 60/min pool? (A1, A3)
3. Should Darwin messages extend `fetchNrBoard()`/`NrBoard`, or use a separate call/endpoint? (A1)
4. Does `affectedRoutes`/`affectedStops` populate for severe/long-running incidents, or is it effectively empty (A2's 0% over 6 days) vs populated (B1 live)? Longer window or TfL support inquiry. (A2)
5. Circle-line pairs across the Edgware Road breakpoint: chain two branches or fall back to line-level? (A2)
6. Reuse `road-disruptions.ts` `SEVERITY_COLORS` pattern for rail severity? (A2)
7. Bus gazetteer bootstrap: resurrect `StopPointRef`/`AtcoCode` in `fetch-bus-prior.mjs`, or a fresh bake against `/StopPoint/Mode/bus` (pagination unverified)? (A3)
8. Fast-forward local `main` to origin/main before implementation? (A3)
9. Do 17 hub boards give near-complete London NR disruption coverage? Needs dedup diff across hubs over time. (A4, B3)
10. Is a National Rail Knowledgebase / incidents feed (structured affected-CRS lists) reachable under the existing DARWIN_TOKEN / RDM subscription? (A4, B3)
11. Should `delayReason`/`cancelReason` attach to trains (by `rid`) rather than stations/segments? (A4)
12. Real production concurrency of `/api/nr-board` pollers to confirm the ~17 calls/min headroom. (A4)
13. Badge as a new derived source vs data-driven paint on `stations-circle`? Backend vs frontend computation of the gazetteer parse? (A5)
14. Does `affectedRoutes[].id` ('2105','2330') correspond to Route/Sequence `orderedLineRoutes` or `line.routeSections`? (B1)
15. Does TfL ever emit duplicate per-platform / 9400… ids in `affectedStops` as `tube-status-recorder.test.ts:117` assumes? (B1)
16. Structured behaviour on tram (930G) and DLR partial closures? (B1)
17. Elizabeth: 910GPADTLL 'Paddington' and 910GPADTON 'London Paddington' both in `elizabeth.json` — two points for one station; which do segments attach to? (B1)
18. Can the recorder body be shared with `/api/disruptions` without breaking its change-detection dedup? (B1)
19. Bus prose -> stop ids without an LLM (quoted-stop-name pattern in 17/49 only; no bus-stop gazetteer)? (B1)
20. Does a CRS<->910G bridge exist for Overground/Elizabeth stations shared with NR? (B1)
21. Does the RDM gateway ever emit severity/category on `nrccMessages` or `adhocAlerts` on services? (B3)
22. Are board `nrccMessages` strictly those whose Darwin affected-stations list includes that CRS (board station a valid fallback anchor)? (B3)
23. What do `affectedByDiversion=true` / `rerouteDelay>0` look like; any per-location diversion text? (B3)
24. Is the href slug ('amberley-20260828', 'windrush-line-20260902') a reliable secondary gazetteer key? (B3)
25. How long do messages persist after resolution (a 20260813 'railway is open' notice still served 20260902)? (B3)
26. Why is the earlier "428 of 604" location-phrase figure not reproducible? (B2, unverified)

### 8.2 To-verify checklist
- [ ] Reconcile line numbers and the `fetchLineStatusByModes` / `affectedRoutes` grep contradiction (A1 vs A2/B1) on a single checkout; confirm whether local `main` vs origin/main explains it.
- [ ] Re-run A2's `ar`/`as` population count over a longer archive window (PERSIST_DIR/tube-status) and against B1's live samples to settle how often structured fields fire.
- [ ] Probe `detail=true` and the date-window form for tram, DLR, bakerloo/central/jubilee/piccadilly/metropolitan under real disruption.
- [ ] Verify the recorder's `SUBDIR`/archive path and whether a second consumer can share its fetched body.
- [ ] Verify each line's `data/stations/<lineId>.json` has at most one row per bare name (only 3 lines checked).
- [ ] Verify `New Cross ELL` id 910GNWCRELL (name verified only).
- [ ] Verify whether learned bus route files carry stop ids on origin/main (A3 says no; B1 marks unverified) and whether `/StopPoint/Mode/bus` returns all stops in one call.
- [ ] Verify the ~19,000 London bus-stop count (public-domain figure, not in repo).
- [ ] Verify LDBWS `GetDepBoardWithDetails` `nrccMessages` shape over more boards/times (severity/category, adhocAlerts, diversions) — single evening snapshot so far.
- [ ] Measure real `/api/nr-board` concurrency and Darwin call rate in prod.
- [ ] Confirm `affectedRoutes[].id` correspondence with Route/Sequence.
- [ ] Confirm the 'changes at X' / 'change at' template exists in TfL text (0/216 in A2's window).
- [ ] Manual QA of `NrRailGraph.railPath` corridors at Clapham Junction-type junctions against real disruption examples.
- [ ] Confirm the road-disruption feed comment location (`app.ts:206-207`) and `tflBudget` line on origin/main.
