# Geolocating TfL disruption notices without an LLM

> Status: **P0 implemented on branch `feat/disruptions-p0`, P1 not started** (2026-09-03). This is the
> engineering record for the feature; the implementation contract is
> [`DISRUPTION_GEOLOCATION_SPEC.md`](DISRUPTION_GEOLOCATION_SPEC.md) and the evidence base is
> under [`disruption-geolocation/`](disruption-geolocation/). Numbers marked *measured* cite
> the repository's archive, a live API probe, or a prototype run; anything not measured is
> marked *unverified*.

## 1. The problem

TfL publishes service notices as prose: *"District Line: No service between Earl's Court
and Kensington (Olympia) due to planned engineering work. SEVERE DELAYS on the rest of the
line."* A rider has to read each notice, recognise the station names, and mentally place
them on the network. The map already draws every station and every track segment, so the
notice should land on the map itself: the closed section hatched, the affected stations
badged, the original sentence one tap away.

Constraints set by the operator:

- **No LLM.** Resolution must be deterministic, auditable, and unit-testable.
- **Never attach a wrong location.** A notice that cannot be resolved with certainty is
  shown at line level with its raw text, not guessed onto a segment.
- Scope priority: **Tube / DLR / Overground / Elizabeth line / Tram, then bus, then National Rail.**
- The browser must receive resolved identifiers, never raw upstream bodies. Egress was the
  original worry; the current bill is dominated by RAM, so resident memory is bounded too.

## 2. Why this is a closed-world problem, not an NLP problem

Three facts make an enumerative, rule-based approach the right tool:

1. **The vocabulary is closed.** Every station on the 25 baked lines has a name and a
   NaPTAN id in `data/stations/<line>.json` (*measured*: 676 rows, 537 distinct ids, 496
   distinct names); National Rail stations have CRS codes in `data/nr/stations.json` (431,
   no duplicate names). A notice can only name stations from this list plus a small alias table.
2. **The sentences are templated.** They come from TfL's control-room tooling with a fixed
   phrase set. Ten days of archived statuses contain 604 distinct sentences, and roughly 85%
   of the location-bearing ones are one of a handful of shapes:
   *`<severity> between <STN> and <STN> [and <severity> on the rest of the line] [while we fix | due to] <cause> at <STN>`*.
3. **Part of the answer is already structured.** With `?detail=true` the TfL line-status
   endpoint attaches `disruption.affectedRoutes` (ordered NaPTAN stop sequences) and
   `disruption.affectedStops`; Darwin departure boards carry station-scoped `nrccMessages`.
   Where those fields are populated no parsing is needed.

So "enumerate all possibilities" means enumerating **templates × gazetteer**, a few dozen
patterns over a few hundred names, not enumerating sentences.

### 2.1 Corpus evidence (*measured*)

Source: `~/bus-archive/tube-status/2026-08-23 … 2026-09-01.jsonl`, written by the backend's
line-status recorder every 2 minutes and pulled to the operator's machine daily. Analysis
script and full report: `disruption-geolocation/corpus/`.

| Metric | Value |
|---|---|
| Days | 10 |
| Snapshot rows | 1,113 |
| Status entries carrying a reason sentence | 11,476 |
| Distinct reason sentences | 604 |
| … with a location phrase after *between / at / from / to / via / towards* | 510 (84%) |
| … containing *between A and B* | 408 |
| … with only a cause station (*… at X*) | 101 |
| … no location phrase at all (line-wide by construction) | 94 |

How much a deterministic parser can place, by increasingly permissive rule set:

| Rule set | FULL | PARTIAL | NONE |
|---|---|---|---|
| Strict: every location token must be a station on the stated line | 281 | 229 | 94 |
| + relaxed normalisation (case, `&`/`and`, apostrophes, periods, hyphens, whitespace) | 408 | 102 | 94 |
| + 10-entry alias table, line-scoped lookup, edit distance 1 for typos | 448 | 62 | 94 |
| + sentence policy (ignore replacement-bus, ticket-acceptance, other-line sentences; cause stations may be any station) | **505 (83.6%)** | 4 | 95 |

Occurrence-weighted, the last row places 65.4% of all status entries fully and leaves 34.2%
line-wide because they name no place. A naive regex shows why the parser must be
**gazetteer-first**: on *"between Fulham Broadway and Wimbledon, and Earl's Court and
Kensington (Olympia)"* a `between (.+) and (.+)` pattern captures the wrong span at the
second *and*.

Structural features the grammar must cover, with counts over the 604 distinct sentences:

| Feature | Count | Example fragment |
|---|---|---|
| Remainder clause | 359 | *… and SEVERE DELAYS on the rest of the line* |
| Ticket-acceptance sentences naming other operators | 244 | *Tickets will be accepted on … C2C and Thameslink* |
| Multi-section | 98 | *between Harrow-on-the-Hill and Aldgate and between Moor Park and Watford* |
| Direction qualifier | 57 | *Acton Town and Uxbridge eastbound only*; *Baker Street Southbound* |
| Dated planned closure | 33 | *Saturday 29 August, from 0330 (including Night Tube), and all day Sunday 30 …* |
| Routing *via* (branch choice) | 22 | *between Aldgate and Edgware Road via Victoria*; *via Charing Cross* |
| Replacement-bus sentences (road routing, not stations) | 7 | *Replacement bus service NL3 operates between Archway and High Barnet via Highgate …* |
| Fork endpoints | several | *Bank / Tower Gateway*; *High Barnet / Mill Hill East*; *Enfield Town / Cheshunt* |
| Feed typos | several | *Harrow-on-the- Hill* (126 occurrences), *West Ruilsip*, *Seven Sister*, *Camden Town Golders Green* |
| Non-stations in location slots | several | *Wembley Arena*, *Notting Hill*, *Morden Depot*, *Aylesbury* (off map) |

## 3. Data sources (*measured* 2026-09-02, a quiet Wednesday evening: 3 rail lines disrupted)

### 3.1 TfL Unified API

| Endpoint | Size raw / gzip | What it actually contains |
|---|---|---|
| `/Line/Mode/{rail modes}/Status?detail=true` | 399 KB / 12.7 KB | 22 statuses; `affectedRoutes` on 5/5 disrupted (91% of the bytes), `affectedStops` on 2/5, `validityPeriods` on 5/5. `reason` equals `disruption.description` byte for byte. |
| `/Line/Mode/{rail modes}/Status` | 19 KB / 1.3 KB | Same statuses; `disruption` present but `affectedRoutes`/`affectedStops` empty. |
| `/Line/{ids}/Status/{from}/to/{to}?detail=true` | 607 to 668 KB / 23 to 24 KB | **Superset**: everything live (`isNow: true`) plus planned works days ahead (`isNow: false`). `affectedRoutes` 15/15, `affectedStops` 11/15. Accepts all 20 manifest ids including tram in one URL; the mode form of this call returns 404. |
| `/Line/Mode/{rail}/Disruption` | 2.3 KB / 0.5 KB | Prose only, no line id, no stops. Strictly less than the status call. |
| `/StopPoint/Mode/{rail}/Disruption` | 46 KB / 5.2 KB | 77 station-scoped entries at 55 stations, all ids present in the baked data. Mirrors the line-status `affectedStops` per station and adds facility notices (lifts, escalators, *westbound trains not stopping*). |
| `/Line/{id}/Route/Sequence/{dir}` | 81 to 133 KB | `stopPoint[].id` matches baked ids 100%; `stations[].id` uses HUB ids for 11 of 29 stops on Windrush. `orderedLineRoutes[].naptanIds` are the real service patterns. Join on `stopPoint.id`, never `stations[].id`. |
| `/Line/Mode/bus/Status?detail=true` | 10.4 MB / 681 KB | Timed out uncompressed. 387/387 affected routes are whole routes. Zero localisation value. Never proxy. |
| `/Line/Mode/bus/Status` | 745 KB / 41 KB | 217 *Special Service* statuses keyed by route id with reason and validity; 4.6 s to fetch, so it needs a 20 s timeout. |
| `/StopPoint/Mode/bus/Disruption` | 124 KB / 9.3 KB | 303 stop closures keyed by `490…` stop ids with from/to dates. |
| `/Line/Mode/bus/Disruption` | 29 KB / 5 KB | Prose only, no route id field. |
| `/Line/Meta/Severity` | small | Severity codes 0 to 20 confirmed (10 Good Service, 18 No Issues, 20 Service Closed). |

Semantics that decide the design:

- **`isEntireRouteSection` is the switch.** `true` means the sequence is the whole route and
  says nothing about location (Northern *minor delays at Camden Town* lists 16 whole routes);
  `false` means the sequence is exactly the disrupted slice with contiguous ordinals, which
  maps directly onto baked track segments (48/48 partial routes in the window sample are
  edge-by-edge baked branch edges). Only `false` sections and `affectedStops` may be trusted.
- **Point incidents live only in prose.** *"… signal failure at Highbury & Islington"* has no
  structured station.
- **One status per suspended section.** Windrush published two *Part Suspended* statuses
  with one identical sentence and different `affectedStops`; dedupe on the sentence and
  union the stops.
- **Structured ids disambiguate what prose cannot.** The District planned closure *"no service
  Edgware Road - Wimbledon"* listed `940GZZLUERC` (Circle-line Edgware Road) and `940GZZLUPAC`,
  which no name lookup could pick.
- **RealTime validity end times roll.** For a live suspension `toDate` is a rolling
  "now + 2 to 3 hours" stamp (three fetches: 23:17Z, 23:23Z, 00:54Z) and `fromDate` was
  rewritten mid-incident when TfL re-issued the status. They are never an end time and never
  a dedup key. Planned-work windows are stable. An earlier version of this document claimed
  the opposite from two samples taken seconds apart; that claim is withdrawn.
- **`disruption.created`** is populated on planned works (stable identity across sentence
  edits) and absent on live incidents; `additionalInfo` carries replacement-bus text on 4/9
  planned statuses. Neither is archived yet.
- **The date-window form filters by validity-period overlap, not by start date** (*measured*
  2026-09-03, two independent probes). A District closure starting 2026-09-05T02:30Z was
  returned for a window opening on 09-06 with its validity periods clipped to the window;
  three strictly past two-day windows returned zero RealTime statuses while the Mode form
  carried three live ones, so the window form is not a history API. Boundaries are
  London-local midnights, the `to` date is exclusive, and `from == to` is a 400. A live
  incident that began before `from` therefore stays in the body for as long as its rolling
  period covers now. The recorder still shadow-compares every window body against the
  no-detail Mode form and logs `tube-status: window-miss` if that ever fails to hold.
- **TfL error bodies echo the app key.** Both the 404 for an unknown line id and the 400 for
  `from == to` return `ApiError.relativeUri` with the full query string, key included
  (*measured*). Nothing may forward or log an upstream error body verbatim.
- **Severity 20 does not linger.** Over ten archived nights every tram *Service Closed* run
  ended between 03:50 and 04:27 London, flipping to Good Service or a planned Part Closure;
  across all lines the only runs alive after 06:00 were Waterloo & City on two mornings, by
  at most 11 minutes (*measured*). A whole-line hatch for code 20 is literally true.
- Why the production archive had never shown structured fields: production never asked for
  `detail=true`. Fixed by the recorder change in §12.

### 3.2 National Rail Darwin (*measured*, 6 boards)

The backend already polls departure boards (`backend/src/darwin-client.ts`, `nr-sampler.ts`,
budget 40 requests/min). Boards carry `nrccMessages` as HTML strings with no severity, id or
expiry, present only when a station has messages (4 of 6 boards; 10 occurrences, 7 distinct
texts). The current client discards them, so surfacing them costs **zero new upstream calls**.
Per-service `delayReason` and `cancelReason` never contain a place name; cancelled calling
points carry CRS codes. Of the 14 places named in the 7 messages, 9 are outside the map's
bounding box; 2 messages resolve fully, 1 partially, 3 not at all, 1 names no place. Link
slugs carry the incident *start* date (a 2026-08-13 *"railway is open"* notice was still
served on 2026-09-02), so they cannot be an expiry.

### 3.3 The repository's own archive

The generic snapshot recorder (`backend/src/status-recorder.ts`) appends deduplicated
line-status snapshots to `<persist>/tube-status/YYYY-MM-DD.jsonl`. As of this change the
tube-status feed requests `detail=true` and archives the structured fields, so every future
reason sentence is stored next to the NaPTAN ids TfL says it covers. That pairing is the
evaluation set for the parser.

Archived entry shape (short keys; every new key optional, so older files serialize unchanged):

| Key | Meaning | Source field |
|---|---|---|
| `s` | severity code, 10 = Good Service | `statusSeverity` |
| `d` | severity description | `statusSeverityDescription` |
| `r` | reason sentence | `reason` |
| `c` | `RealTime` / `PlannedWork` / `Information` | `disruption.category` |
| `ct` | e.g. `partClosure`, `severeDelays` | `disruption.closureText` |
| `v[]` | `{f, t?, n?}`; `t` only for non-RealTime periods (rolling live end times would defeat dedup) | `validityPeriods[]` |
| `ar[]` | `{id, n?, dir?, o?, de?, e?, st?}`; `e` = isEntireRouteSection; `st` omitted when `e` is true (whole-route lists were 91% of the body and carry no location) | `disruption.affectedRoutes[]` |
| `as[]` | deduplicated NaPTAN ids | `disruption.affectedStops[]` |

Two polls of the same live suspension whose only difference is the rolling `toDate`
serialize identically, so a quiet network still costs a handful of rows per day.

## 4. Name resolution (*measured*)

- **39 names exist under two or more NaPTAN ids** (Paddington ×3, Edgware Road, Hammersmith,
  Bank, Canary Wharf ×3, Stratford ×3, Whitechapel ×3, Liverpool Street ×3 …). None are
  different places. Resolving inside the notice's own `data/stations/<lineId>.json` removes
  the ambiguity; the line id comes from the status entry, and the sentence prefix
  (*"District Line:"*) is matched case-insensitively against `manifest.json` names.
- **Within one line, exactly four id pairs are co-located** (≤ 300 m apart) and are treated
  as one node: Circle Paddington (H&C platforms vs main, 255 m), Elizabeth Paddington (82 m),
  Elizabeth Liverpool Street (52 m), Mildmay Clapham Junction (5 m). Every other duplicate is
  a collision and only the full name resolves.
- **Whole-run matching, never prefix matching.** A station token is the maximal capitalised
  run after an anchor keyword and must equal a key, an alias or a one-edit typo rescue in
  full. Prefix matching was tried in a prototype and attached *Dalston Junction* to Dalston
  Kingsland, *Aldgate East* to Aldgate, *Edgware Road* to Edgware, *Harrow & Wealdstone* to
  Harrow-on-the-Hill, and *Shepherd's Bush Market* to Shepherd's Bush.
- **Normalisation.** Lower-case, apostrophes and periods deleted, `&` to *and*, hyphens to
  spaces (which absorbs the *Harrow-on-the- Hill* feed typo), one trailing parenthetical
  stripped as a second key only when unique on the line, mode suffixes (*Tram Stop*,
  *Underground Station*) removed but never a bare *Station* (Battersea Power Station).
- **Alias table (from corpus misses):** `King's Cross`, `Heathrow` / `Heathrow Terminals` /
  `Terminal 5` (a fork endpoint set, never a cause point), `New Cross` (Windrush), `Harrow`
  (Metropolitan), `Dalston` (Windrush / Mildmay); *"A / B"* splits into fork alternatives.
  `Wembley Arena`, `Notting Hill`, `Morden Depot`, `Aylesbury` stay unresolved on purpose.
- **Keyword anchoring is mandatory.** Free matching hits *Bank Holiday*, *Wembley Arena*,
  *Notting Hill Gate carnival*, *travelling beyond Loughton*. Only tokens after
  *between / and / at / from / to / via / towards / through* and the dash form are candidates.
- **Sentence scoping is mandatory.** Replacement-bus routing (*via Highgate, East Finchley …*),
  ticket acceptance and other-line clauses name stations that must not be attached. Date and
  time phrases are masked before classification, otherwise *"from 0330"* looks like a
  timetable sentence and the 316-occurrence Northern closure is discarded.

## 5. The design

The full contract is in the spec; this section records the decisions and why they hold.

**One backend route, three tiers, fail closed.** `GET /api/disruptions` is a lazily cached
proxy route (fixed cache key, 60 s TTL, single-flighted, stale-on-failure bounded at 10
minutes). On a miss it fetches the date-window status call for all 20 rail lines from
yesterday to seven days ahead, shapes the body with the recorder's own compaction, and
resolves every non-Good status:

| Tier | Input | Output | Guard |
|---|---|---|---|
| 0 structured | `affectedRoutes` with `isEntireRouteSection: false`, `affectedStops` | ordered NaPTAN paths | every id must be on the line and every consecutive pair a baked branch edge; a bad route is dropped and logged |
| 1 parsed | the sentence | sections and cause points | whole-run gazetteer, 18-rule grammar, slices of real route patterns only; runs in **shadow** from day one and renders only behind a production flag after a measured gate |
| 2 fallback | anything else | line-level item with the raw sentence | always reachable; a sentence can never 500 the route |

Rules that came out of the adversarial review and are now load-bearing:

- **Route patterns, not graph search.** Tier-1 geometry is a slice of one of TfL's own
  `orderedLineRoutes` (to be baked into `data/route-patterns/<line>.json`), or nothing. A
  prototype showed that depth-first search over branch fragments invents paths: Mornington
  Crescent on a "via Bank" slice, an ambiguous pair of paths for *Colindale to Battersea Power
  Station via Charing Cross* where the real patterns give exactly one 20-stop slice. A line
  without a validated pattern file gets no parsed geometry at all.
- **Closest-pair rule on loops.** Circle patterns list Edgware Road at both ends of the ring,
  so *"between Edgware Road and Paddington"* has a 2-stop slice and a 26-stop wrap-around
  slice that are nested; only the slice with the smallest index distance is a candidate.
- **Nesting only with identical concrete endpoints.** Two co-located Liverpool Street ids give
  a 14-stop direct Shenfield slice and a 15-stop slice through Whitechapel; treating them as
  nested drew the tunnel for a metro closure. Non-nested multiplicity fails closed unless
  *via* disambiguates.
- **Cross-direction collapse.** Asymmetric lines produced two overlapping arcs for one
  section (Metropolitan Harrow-on-the-Hill to Aldgate, 624 corpus occurrences); identical or
  safely nested direction results become one section, interior-disjoint results become two
  one-way sections, anything else fails closed.
- **Whole-line closures are drawn as whole-line hatches**, which is literally true: severity
  codes 1, 2 and 20, and planned closures whose routes are all entire routes. The six empty
  Overground *"<Name> Line:"* strings are all `Service Closed`.
- **Whole-run matching, case-insensitive line prefixes, masks before sentence policy**, all
  from prototype failures on real sentences (§4).
- **Text only until the gate.** With the flag off, an accepted parsed section emits no
  geometry and no endpoint ring; a clause that fails closed never emits its endpoints either.
  Cause points (*"at Camden Town"*) are the one prose-derived mark allowed, and only when the
  name resolves on the status's own line.
- **Currency.** Items are keyed by line and canonical sentence, never by validity dates. The
  client greys the layer after 5 minutes without a fresh payload and clears it after 10.

Merging: one item per (line, canonical sentence); sections are the union of the merged
statuses' Tier-0 slices, each with its own severity class; the item's class comes from the
worst status code, never from text.

## 6. Sequence diagrams

### 6.1 Live path: TfL → backend → browser

```mermaid
sequenceDiagram
    participant TfL as TfL Unified API
    participant P as Fastify /api/disruptions
    participant C as TtlCache + RateBudget
    participant R as Resolver (tier 0 / 1 / 2)
    participant B as Browser layer

    B->>P: GET /api/disruptions (registerPoll 90 s, paused when hidden or toggled off)
    P->>C: fresh hit?
    alt fresh
        C-->>P: shaped payload, x-cache: hit
    else miss, no fetch in flight, budget available
        P->>TfL: /Line/{20 ids}/Status/{today-1}/to/{today+7}?detail=true (≈23 KB gzipped)
        TfL-->>P: statuses + disruption objects
        P->>R: compactStatus → resolveSnapshot(gazetteer, line graph, route patterns)
        R-->>P: items[] with NaPTAN id paths, notices[], nr[] from the cached Darwin boards
        P->>C: store (60 s); shadow log for parser disagreements
    else miss while a fetch is in flight
        C-->>P: await the same promise (no second upstream call)
    else miss, budget exhausted or upstream failed
        C-->>P: stale payload if younger than 10 min, x-cache: stale; else 429 / 502
    end
    P-->>B: compact JSON, cache-control: no-store
    B->>B: build bands and rings from the branch geometry it already holds; drop any section with a missing hop
```

### 6.2 Archive path (live after this change)

```mermaid
sequenceDiagram
    participant T as SnapshotRecorder tube-status (2 min)
    participant TfL as TfL Unified API
    participant F as persist/tube-status/YYYY-MM-DD.jsonl

    T->>TfL: /Line/Mode/tube,overground,dlr,elizabeth-line,tram/Status?detail=true
    TfL-->>T: statuses with disruption.affectedRoutes / affectedStops
    T->>T: compactStatus → {s,d,r,c,ct,v,ar,as}; no st for entire routes; no RealTime end time
    T->>T: changed since last write, or 30 min heartbeat?
    T->>F: append one JSON line
```

The spec moves the recorder to the window form in the first implementation phase so that
planned works with structured fields enter the archive too.

## 7. Endpoint contract (summary)

`GET /api/disruptions`, no query parameters. Headers `x-cache: hit | miss | stale`,
`cache-control: no-store`. The body never contains `affectedRoutes`, `affectedStops`,
`commonName`, coordinates or the app key; a route test asserts the exact key set.

```jsonc
{
  "t": 1788047956,                  // unix seconds the upstream body was fetched
  "w": ["2026-09-01", "2026-09-09"],// requested window
  "pf": 0,                          // 1 when parsed sections are enabled for rendering
  "items": [{
    "id": "district:9f1c2b3d:partClosure",   // line : hash(canonical sentence) : worst closureText
    "l": "district", "m": "tube",
    "s": 5, "d": "Part Closure", "k": "closed",   // k from the severity code only: closed | severe | minor | info
    "c": "P", "n": 0,                         // category initial; whether any validity period is live now
    "v": [{ "f": "2026-09-05T02:30:00Z", "t": "2026-09-07T00:29:00Z" }],  // t only for planned periods
    "sc": "section", "src": "s", "wl": 0,      // scope; source s | p | f; whole-line flag
    "sec": [{ "st": ["940GZZLUERC", "940GZZLUPAC", "…", "940GZZLUWIM"], "k": "closed", "dir": "b" }],
    "pts": [{ "id": "940GZZLUCTN", "role": "cause" }],
    "rest": "severe",
    "r": "District Line: Saturday 5 and Sunday 6 September, no service Edgware Road - Wimbledon …"
  }],
  "notices": [{ "id": "940GZZLUBSC", "ty": "P", "ap": "R", "f": "…", "t": "…", "l": ["circle","district","piccadilly"], "d": "BARONS COURT STATION: …" }],
  "nr": [{ "crs": "CLJ", "g": 1788047956, "msgs": [{ "m": "A reduced service is in operation between …", "ok": 0, "h": 1, "a": "2026-09-02" }] }]
}
```

Bus notices use a second route, `GET /api/bus-notices?line=<id>`, keyed by lower-cased TfL
route id, shipping the full reason (67% of bus reasons exceed 300 characters and the
operative text is at the end) for one route per click.

## 8. Rendering and UX (summary)

- **Closed sections** are a red translucent wash with a black dashed hatch on top; **severe
  delays** a solid amber wash; **minor delays** a dotted yellow wash. A line-coloured core
  stroke and the existing line offsets say *which* line on the shared Circle / District /
  H&C / Metropolitan corridor; the popup lists the other lines on that track as "not reported
  affected". Shape, not colour alone, encodes the class.
- **Station rings** sit under the station dots so a tap on a dot still opens the existing
  station popup, which gains the notice line; the band's click handler yields when a station
  or vehicle dot is under the tap.
- **Line-wide items draw nothing on the map.** A mark at a place would imply a place. They
  reach phones through a compact Service strip in the Lines tab and a coloured pip on each
  line row; desktop also gets the line hover tooltip.
- **Planned works** live on a separate source behind a default-off toggle (blue long dash);
  live and planned are separate layers because the Lines-tab filter replaces a layer's filter.
- **Currency**: greyed after 5 minutes, cleared after 10; RealTime items show *since HH:MM*
  and never an end time.
- Polling goes through `registerPoll` (paused when hidden, refreshed on return, gated on the
  toggle) and hidden layers skip feature building; no request is made while the overlay is off.
- Everything from upstream passes the module-local `esc()` before entering the DOM;
  attributes are set as DOM properties because that helper does not escape apostrophes.

## 9. Bus and National Rail decisions

- **Bus ships route-level only.** A *Special Service* route gets a translucent wash over its
  learned polyline behind a default-off toggle and the full reason in the bus popup. Stop-level
  pins are deferred: no `490…` stop id to coordinate gazetteer exists anywhere in the
  repository (the bus prior fetch discards `StopPointRef`), and building one is a few-MB
  one-off bake of roughly 19,000 stops (*unverified* count).
- **National Rail ships hub messages with zero new calls.** The 17 hub boards already in the
  cache keep their `nrccMessages`; they appear as text in the hub's popup and the Service
  strip, and a ring is drawn **only when a message names the hub itself**. Five of the seven
  sampled messages named no station inside the map, so a Horsham incident must never ring
  Clapham Junction. Section geometry for National Rail is deferred: 2 of 7 messages were
  resolvable and the baked graph encodes one shortest path per adjacent pair, not the physical
  corridor at junctions.

## 10. How the design was produced and attacked

The design was not written once. It was produced by a judged panel and then attacked:

1. **Research, nine agents.** Five read-only code explorers mapped the status chain, the
   baked graph, the bus side, the National Rail side and the layer conventions; three probes
   sampled the TfL and Darwin APIs live and analysed the 604-sentence corpus with a
   zero-dependency script. Their merged note is `disruption-geolocation/research-findings.md`.
2. **Three independent designs** from different angles: structured-first and minimal,
   parser-first and robust, rider-experience-first. **Two judges** (one paying the hosting
   bill, one owning the rider experience) scored coverage, wrong-attachment risk, cost, code
   fit, effort and testability. Structured-first won on both cards (27 and 25 of 30); the
   judges named a dozen grafts from the other two and nine concerns none had addressed.
3. **Three skeptics attacked the synthesized design.** One wrote a throwaway prototype of the
   normalisation, gazetteer, grammar and path rules and ran it over all 604 sentences and 60
   pinned path probes. One re-opened every cited file and line on the current checkout,
   recomputed the budget and egress arithmetic, and attacked the bus and rail sections. One
   read the proxy, cache and lifecycle code for operational failure modes. **Together they
   refuted 27 of 51 claims**, six of them high or critical.
4. **A revision folded every refutation in**, then a completeness critic listed what an
   implementer would still have to invent.

Refutations that changed the design:

| Claim | What the evidence showed | Change |
|---|---|---|
| Nested-slice collapse is safe on loop lines | Circle *Edgware Road to Paddington* drew the whole 27-stop ring | closest-pair rule; wrap-around never a candidate |
| Co-located ids are safe | *Liverpool Street to Shenfield* drew the Whitechapel tunnel | nesting requires identical concrete endpoints |
| Longest-prefix matching never attaches an off-line name | seven wrong attachments including *Dalston Junction* to Dalston Kingsland | whole-run matching, exact-only aliases |
| The sentence policy only drops non-mineable sentences | `customers?` and bare four-digit numbers discarded 4.3% of all occurrences, including the 316-occurrence Northern closure | masks before classification; policy regex tightened |
| Branch fragments are a safe fallback when patterns are missing | 26% fewer sections and phantom paths when fragments are chained | baking all 20 pattern files is a hard gate |
| One direction gives one arc | Metropolitan drew two overlapping arcs per section | cross-direction collapse |
| Returning a non-200 from the fetch closure serves stale | the proxy forwards non-200 bodies; only a throw reaches the stale path | the closure throws |
| Staleness is bounded by validity windows | live `toDate` rolls forward every poll; the cache has no age cap | 10-minute max-stale on both sides; live end times dropped |
| One upstream call per minute regardless of viewers | no in-flight coalescing; a failing minute could spend two budget units per viewer poll | single-flight and 30 s failure back-off in the proxy |
| The recorder's dedup survives the extra fields | rolling `toDate` would write a 40 KB row every 2 minutes during any suspension | RealTime end times and whole-route stop lists dropped (this change) |
| Rings under the station dots avoid double popups | MapLibre fires every layer-scoped handler with a feature under the tap | band handler yields to dots |
| National Rail rings at the hub are fail-closed | 5 of 7 messages named no station in the map | ring only when the message names the hub |

## 11. Phased implementation plan

| Phase | Adds or changes | Effort | Done when |
|---|---|---|---|
| **P0 prerequisites** | commit the recorder change; extract the status shaping into `backend/src/disruptions/tfl-status-shape.ts`; window, StopPoint and bus fetchers; recorder on the window form via a feed factory; `scripts/bake-route-patterns.mjs` and `data/route-patterns/*.json` for all 20 lines, both directions, hop-validated; proxy-route single-flight, back-off, max-stale and shape hook as its own PR with a new test file | 1 to 1.5 days | 20 pattern files with zero dropped hops; the path table re-pinned on baked files; first archived production day measured |
| **P1 pure core** | gazetteer, line graph, grammar, resolver, National Rail messages, and their tests; corpus fixture | 3 days | corpus regression FULL ≥ 505/604 with zero wrong-location signatures; the 9 sectional oracles of the window sample match exactly |
| **P2 route, wiring, harness** | `/api/disruptions`, capability flag, `/health` counters, Darwin messages kept in the cache, the archive evaluation harness | 1 to 1.5 days | live curl matches the contract; mocked 404 serves stale or 502; ten parallel cold requests make one upstream call |
| **P3 map layer** | Tier 0 sections, whole-line hatches, own-line cause pins, station rings, planned toggle, Service strip, popups | 2 days | screenshots checklist; zero prose-derived geometry in the payload; an 11-minute outage clears the map |
| **P4 gate and bus** | flip the parsed-sections flag after ≥ 30 structured statuses with no disjoint or superset disagreement; station notices; bus route-level notices | 1.5 days plus the wait | a live incident with no structured fields draws from prose with `src: p` |
| **P5 National Rail** | hub messages as text, self-naming ring, board-age greying | 0.5 day | a Horsham message on Clapham Junction shows as text with no ring |
| **Post-ship** | weekly harness over the archive; each new high-occurrence skeleton becomes a rule with a corpus-sentence test | 0.5 day a week for a month | four weeks with no disagreement |

The critic's recommended first PR carries no user-visible change: the recorder commit, the
recorder on the window form, the route-pattern bake, two cheap probes (window overlap
semantics with `to = today - 2`; the London date helper across the clock-change boundaries),
and the proxy-route change kept separate because every TfL route goes through it and it has
no tests today.

**P0 status (2026-09-03).** Delivered on branch `feat/disruptions-p0` (recorder on the window
form with a Mode-form fallback and a shadow comparison, shaping extracted to
`backend/src/disruptions/tfl-status-shape.ts`, `londonDay()` in `backend/src/shared/`,
`scripts/bake-route-patterns.mjs` with 20 validated pattern files and their loader) and on
`feat/proxy-route-single-flight` (single-flight, 30 s back-off, `maxStaleMs`, `shape`, the
first `proxy-route.test.ts`). Backend suite 158 → 223 tests on the first branch, 182 on the
second. The one P0 done-criterion still open is the first archived production day.

## 12. Change log

| Date | Change |
|---|---|
| 2026-09-02 | Local `main` was 36 commits behind `origin/main` (the recorder had been generalised into `status-recorder.ts`, and the diversion detector existed only upstream). Fast-forwarded before any edit. |
| 2026-09-02 | Tube-status feed of `SnapshotRecorder` requests `?detail=true` and archives `c, ct, v, ar, as` alongside `s, d, r`. Older archive files remain byte-identical in shape. |
| 2026-09-02 | After the adversarial review: whole-route stop lists (`e: true`) are archived without `st` (−30% per snapshot), and RealTime validity periods keep only their start, so the change-detection dedup survives TfL's rolling end times. 158/158 backend tests pass. The earlier claim that validity windows are stable is withdrawn. |
| 2026-09-02 | Design complete: `DISRUPTION_GEOLOCATION_SPEC.md` (13 sections plus completeness critique); research under `disruption-geolocation/`; raw samples and prototypes in `~/bus-archive/disruption-research/2026-09-02/`. |
| 2026-09-03 | P0 built by a 15-agent workflow: three implementers in isolated worktrees, a read-only probe agent, two reviewers per branch, a skeptic recomputing the bake from the raw files, one fix round each. Two HIGH findings fixed before merge: a thrown window fetch skipped the Mode-form fallback; an empty pattern file disabled Tier 1 silently. |
| 2026-09-03 | Route patterns baked: 125 `orderedLineRoutes` over 20 lines, **0 dropped hops, 0 HUB ids in `naptanIds`** (HUB ids appear only in `stations[]`), 51 KB on disk, raw responses under `~/bus-archive/disruption-research/2026-09-03/route-sequence/`. Inbound patterns exist for every line and mirror outbound on 14; **dlr, elizabeth, metropolitan, mildmay, piccadilly and tram are asymmetric** (one-way loops at Heathrow T4 and Croydon, Metropolitan skip-stops, the co-located Clapham Junction pair). |
| 2026-09-03 | Circle corrected: TfL's patterns are one 37-stop Hammersmith → Edgware Road → ring → Edgware Road run per direction in which only `940GZZLUERC` repeats; the "Aldgate 9/18, Victoria 19/8" shape in the spec's §5.4 describes `data/branches/circle.json`, not the patterns. Closest-pair still resolves Edgware Road; a new hazard is recorded for P1: *Edgware Road–Paddington* yields 2-stop slices to different co-located Paddington ids on either side of Edgware Road. |
| 2026-09-03 | Spec §5.4 table re-pinned on the baked files: Metropolitan Harrow-on-the-Hill–Aldgate is 14 (15 only on the outbound Amersham pattern) and Baker Street–Harrow 6 (7 outbound only) because no inbound all-stations pattern exists; Piccadilly Acton Town–T4 is 10 inbound / 11 outbound; every other row reproduced exactly. |
| 2026-09-03 | Window-form semantics, key echo in error bodies and severity-20 persistence measured (§3.1). `backend/package.json` engines aligned to the Node 22 runtime; `data/**/leaderboard/` ignored so the dev server's day archives never enter a commit. |

## 13. Risk-control checklist

| # | Risk | Control | Status |
|---|---|---|---|
| R1 | Wrong attachment misleads riders | line-scoped gazetteer, keyword anchoring, whole-run matching, sentence scoping, route-pattern slices only, closest-pair and concrete-endpoint rules, Tier 0 wins on contradiction, class from the status code, missing hop dropped, no endpoint ring for a failed clause, `src` shown, production flag | designed, prototype-tested on 604 sentences |
| R2 | Egress | backend resolves; ids only; ≈ 240 KB per client-hour on a busy weekend, about 1% of an open tab | measured |
| R3 | RAM (the actual bill) | resident under 1 MB estimate; one transient ≈ 1 MB parse per 60 s; `/health` counters | to verify on first deploy |
| R4 | TfL 60/min budget | ≤ 1.3 calls/min steady, ≤ 2.3 on a failing minute, independent of viewer count by single-flight | designed |
| R5 | Stale close during an outage | 10-minute max-stale server- and client-side; live end times never used | designed |
| R6 | Archive growth after `detail=true` | whole-route lists and rolling end times dropped; dedup test on two polls | fixed in this change; first-day bytes to measure |
| R7 | Duplicate station names | 39 confirmed; per-line gazetteer; four co-located pairs | measured |
| R8 | Loop and fork lines | route patterns; *via*; closest-pair; fail closed otherwise | designed |
| R9 | Shared-corridor confusion | line-coloured core stroke, line offsets, "not reported affected" list | designed |
| R10 | Region gating | capability flag; Dubai has no TfL key; 503 body guard | existing convention |
| R11 | Mobile render cost | `registerPoll`, hidden layer skips work, no request while toggled off | existing convention |
| R12 | Bus stop names are not unique | route-level only; no bus name parsing ever | scope decision |
| R13 | Darwin token shared with production | zero new calls | measured |
| R14 | XSS via upstream prose | local `esc()`; attributes as DOM properties | convention plus test |
| R15 | Whole-route sequences look like locations | `isEntireRouteSection: true` is line-wide | measured rule |
| R16 | TfL 404 bodies echo the app key | the closure throws; existing redaction on non-200 | designed |
| R17 | Proxy-route change touches every TfL route | separate PR with the first `proxy-route.test.ts` | planned |
| R18 | Colour-vision accessibility | hatch = closed, solid = severe, dotted = minor, long dash = planned | designed |

## 14. Open questions and to-verify list

- [x] `orderedLineRoutes` for all 20 lines in both directions: baked 2026-09-03, 125
      patterns, 0 dropped hops, six asymmetric lines (§12).
- [x] Circle `orderedLineRoutes` do **not** repeat the endpoint the way the branches do; only
      Edgware Road repeats, and the closest-pair rule still holds for it (§12).
- [x] Window-form semantics: overlap with validity periods, `to` exclusive, `from == to` a
      400 (§3.1). The recorder's shadow comparison stands guard in production.
- [x] Severity 20 never outlives the overnight closure on tram; the whole-line hatch is
      literal (§3.1).
- [ ] Recorder shadow comparison (`tube-status: window-miss`): remove, or put behind a flag,
      after one clean week in production. It costs one 19 KB Mode-form fetch per poll.
- [ ] P1: decide which concrete Paddington the §5.4 "Edgware Road–Paddington, 2 stops" row
      means; on the real Circle pattern the two candidates end at different co-located ids.
- [ ] P1: whether step 3 collapses Piccadilly Acton Town–T4 (10 inbound / 11 outbound) and
      the Metropolitan 14/15 and 6/7 pairs into one section each.
- [ ] Structured-field population on tram, DLR and the deep-tube lines during real incidents.
- [ ] First archived production day: bytes per day and rows per day with `detail=true`.
- [ ] `cf-cache-status` for the new route after deploy.
- [ ] Real Darwin call rate in production against the ≈ 17/min headroom.
- [ ] Whether the *"changes at X"* wording exists in TfL text (0 of 604 sentences).
- [ ] Bus-stop gazetteer bake, if the stop-level bus tier is ever scheduled.
- [x] Node engines: `backend/package.json` now says ≥ 22, matching `nixpacks.toml`
      (2026-09-03). The ignored local `CLAUDE.md` still says there is no backend test suite
      and no `npm test` script; its lines 17, 33 and 145 need refreshing by hand.
