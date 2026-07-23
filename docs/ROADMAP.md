# Roadmap: closing the gap to full multi-modal coverage

Reference: Zone One's data-source list (TfL tube/bus/riverboat, Darwin national
rail, ADS-B aircraft, AIS shipping, Overture/OSM map data).

## Where we stand

| Zone One has | Us | Notes |
|---|---|---|
| Tube (TfL, inferred) | ✅ | 19 rail lines, timetable-ratio inference, full anti-jitter stack |
| Riverboat (TfL) | ✅ | Thames-centreline routes, curved docking |
| Map from OSM/Overture | ✅ | Protomaps basemap + OSM track geometry |
| AIS ships | ⚠️ half | Backend feed live; only used to NAME TfL boats — other ships not rendered |
| ADS-B planes/helicopters | ❌ | — |
| National Rail (Darwin boards) | ❌ | Mainline trains across London |
| Bus (TfL) | ❌ | ~9000 vehicles; needs BODS + WebSocket + deck.gl (P3 plan) |
| JamCams | ❌ | TfL traffic cameras with live stills |

## Delivery order (one at a time, small → large)

### Step 1 — Aircraft (ADS-B) · ~half a day · no key needed
- Source: adsb.lol / airplanes.live free API (`/v2/point/{lat}/{lon}/{radius nm}`)
  → real lat/lon/track/altitude/speed, no inference needed.
- Backend: `/api/aircraft` proxy (poll ~5 s, cache, London bbox radius ~25 nm).
- Frontend: plane icon rotated by `track`, size by altitude band; hover =
  callsign + altitude; click = enrich via adsbdb (type, registration, route).
- Helicopters come free (same feed, filter by category/altitude).

### Step 2 — All AIS ships · ~2 hours · key already configured
- We already hold a live vessel table (aisstream WebSocket).
- Render every vessel as its own marker (ship icon, rotate by COG); TfL boats
  keep their bullets — dedupe by proximity so a Clipper isn't drawn twice.
- Also subscribe ShipStaticData for ship type (cargo/tanker/passenger) → icon
  variants + richer popup.

### Step 3 — JamCams · ~2 hours
- Source: TfL `/Place/Type/JamCam` (~900 cameras, id + lat/lon + image URL).
- Backend: proxy the list (long TTL); images load direct from TfL's S3.
- Frontend: camera dot layer (toggle in legend), click = popup with the still,
  refresh ~every 10 s while open.

### Step 4 — National Rail trains (Darwin) · the big visible win · 2–3 sessions
- Source: Darwin via Huxley2 (JSON proxy). Options: public instance
  (huxley2.azurewebsites.net, rate-limited) or self-hosted with a free Darwin
  token from National Rail Enquiries — decide at start.
- Scope decision: London commuter box only (bbox of our basemap).
- Bake: NR station list (~350 in box) + OSM `route=train` geometry for NR lines
  (reuse the existing Overpass stitcher); mainline corridors are already partly
  fetched (Overground shares tracks).
- Inference: from live departure boards (expected departure at origin +
  scheduled calling points) — coarser than TfL countdowns; position = ratio
  along inter-calling-point geometry, same interpolator on top.
- Rendering: one "National Rail" colour (Zone One uses white/grey), same bullet.

### Step 5 — All-London buses (P3 as planned) · the big one · needs YOUR registration
- Register (free) at data.bus-data.dft.gov.uk → BODS API key → `.env`.
- Backend: SIRI-VM poller (~10 s cadence, all London operators), in-memory
  vehicle table, WebSocket broadcasting full snapshots (~9000 vehicles).
- Frontend: deck.gl IconLayer (GPU) — MapLibre symbol layers won't hold 9k
  animated points; straight-line dead reckoning by bearing between updates.
- Bus route shapes optional at first (buses have real GPS — no inference needed).

### Step 6 — Deploy (P5 as planned)
- GitHub push → Cloudflare Pages (frontend + pmtiles on R2) + Railway (backend:
  Fastify + AIS + BODS pollers + WebSocket). Secrets as platform env vars.

## Effort summary

| Step | Size | Blocked on |
|---|---|---|
| 1 Aircraft | S | nothing |
| 2 AIS ships | S | nothing |
| 3 JamCams | S | nothing |
| 4 National Rail | L | Darwin token decision |
| 5 Buses | L | BODS registration (user) |
| 6 Deploy | M | steps above stable |
