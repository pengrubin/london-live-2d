// Unit tests for the pure half of the disruptions layer. disruptions.ts
// value-imports maplibre-gl (Popup), so that module is stubbed to keep this in
// the fast node environment — the emergency-classify.test.ts pattern.
import { describe, expect, test, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ Popup: class {} }));

const {
  currencyOf,
  disruptionPopupHtml,
  disruptionsConnectionLost,
  linePip,
  payloadAgeMs,
  sectionGeometry,
  serverAgeMs,
  stationDisruptionLines,
  toFeatures,
} = await import('./disruptions');

// The layer's only writer of the shared snapshot; the model is a singleton, so
// publishing here is exactly what a rebuild does at runtime.
import { publishSnapshot } from './disruptions-model';

import type {
  DisruptionItem,
  DisruptionSection,
  DisruptionsPayload,
  FeatureContext,
} from './disruptions';
import type { LineBranches } from '../realtime/types';

import LIVE_JSON from './fixtures/disruptions-live.json';

const LIVE = LIVE_JSON as unknown as DisruptionsPayload;

/**
 * The repo's baked branch geometry — the very files the browser downloads.
 * Pulled in with import.meta.glob rather than node:fs so the frontend's own
 * `tsc` (types: vite/client, no node types) still typechecks this file.
 */
const BAKED_BRANCHES = import.meta.glob<LineBranches>('../../../data/branches/*.json', {
  eager: true,
  import: 'default',
});

const bakedBranchesFor = (lineId: string): LineBranches | null =>
  BAKED_BRANCHES[`../../../data/branches/${lineId}.json`] ?? null;

/** Every (line, section) pair in the captured payload, flattened. */
const liveSections = (): { lineId: string; section: DisruptionSection }[] =>
  (LIVE.items ?? []).flatMap((item) =>
    (item.sec ?? []).map((section) => ({ lineId: item.l ?? '', section })),
  );

// ── fixtures: a four-stop line whose hops have distinctive coordinates ──

const ERC = '940GZZLUERC';
const PAC = '940GZZLUPAC';
const WIM = '940GZZLUWIM';
const ORPHAN = '940GZZLUORP';

const stop = (id: string, name: string, lon: number): { id: string; name: string; lon: number; lat: number } => ({
  id,
  name,
  lon,
  lat: 51.5,
});

/** ERC —(0→1)— PAC —(1→2)— WIM, plus a disconnected ORPHAN on its own branch. */
const DISTRICT: LineBranches = {
  lineId: 'district',
  branches: [
    {
      branchId: 1,
      direction: 'outbound',
      stops: [stop(ERC, "Earl's Court", 0), stop(PAC, 'Paddington', 1), stop(WIM, 'Wimbledon', 2)],
      segments: [
        [
          [0, 51.5],
          [0.5, 51.5],
          [1, 51.5],
        ],
        [
          [1, 51.5],
          [1.5, 51.5],
          [2, 51.5],
        ],
      ],
    },
    {
      branchId: 2,
      direction: 'outbound',
      stops: [stop(ORPHAN, 'Orphan', 9)],
      segments: [],
    },
  ],
};

/** Shares the ERC–PAC hop, so it is a co-corridor line. */
const CIRCLE: LineBranches = {
  lineId: 'circle',
  branches: [
    {
      branchId: 1,
      direction: 'outbound',
      stops: [stop(ERC, "Earl's Court", 0), stop(PAC, 'Paddington', 1)],
      segments: [
        [
          [0, 51.5],
          [1, 51.5],
        ],
      ],
    },
  ],
};

const BRANCHES = new Map<string, LineBranches>([
  ['district', DISTRICT],
  ['circle', CIRCLE],
]);

const context = (over: Partial<FeatureContext> = {}): FeatureContext => ({
  branchesByLine: BRANCHES,
  colorByLine: new Map([
    ['district', '#007D32'],
    ['circle', '#FFD329'],
  ]),
  nameByLine: new Map([
    ['district', 'District'],
    ['circle', 'Circle'],
  ]),
  nowMs: Date.parse('2026-09-05T12:00:00Z'),
  stale: false,
  ...over,
});

const payloadOf = (items: DisruptionItem[], pf = 0): DisruptionsPayload => ({
  t: 1_788_048_087,
  w: ['2026-09-01', '2026-09-09'],
  pf,
  items,
});

const CLOSURE: DisruptionItem = {
  id: 'district:9f1c2b3d:partClosure',
  l: 'district',
  m: 'tube',
  s: 5,
  d: 'Part Closure',
  k: 'closed',
  c: 'R',
  // In force now. `n` is what decides live vs planned, so a RealTime fixture
  // with n: 0 would be a contradiction — an incident nobody is inside.
  n: 1,
  v: [{ f: '2026-09-05T11:09:00Z' }],
  sc: 'section',
  src: 's',
  wl: 0,
  sec: [{ st: [ERC, PAC, WIM], k: 'closed', dir: 'b' }],
  pts: [{ id: PAC, role: 'cause' }],
  rest: 'severe',
  r: 'District Line: no service Edgware Road - Wimbledon.',
};

describe('sectionGeometry', () => {
  test('concatenates the branch segments in path order', () => {
    // Arrange — a two-hop section along the baked branch direction.
    const section = { st: [ERC, PAC, WIM] };

    // Act
    const geometry = sectionGeometry(section, DISTRICT);

    // Assert — one part per hop, each running from the earlier stop onward.
    expect(geometry).toEqual([
      [
        [0, 51.5],
        [0.5, 51.5],
        [1, 51.5],
      ],
      [
        [1, 51.5],
        [1.5, 51.5],
        [2, 51.5],
      ],
    ]);
  });

  test('reverses a hop travelled against the baked direction', () => {
    // Arrange — the same track, named the other way round.
    const section = { st: [WIM, PAC] };

    // Act
    const geometry = sectionGeometry(section, DISTRICT);

    // Assert
    expect(geometry).toEqual([
      [
        [2, 51.5],
        [1.5, 51.5],
        [1, 51.5],
      ],
    ]);
  });

  test('returns null rather than bridging a missing hop', () => {
    // Arrange — ORPHAN is on the line but shares no edge with WIM.
    const section = { st: [WIM, ORPHAN] };

    // Act
    const geometry = sectionGeometry(section, DISTRICT);

    // Assert — never a straight line between two stations.
    expect(geometry).toBeNull();
  });

  test('returns null without branch data or with fewer than two stops', () => {
    expect(sectionGeometry({ st: [ERC, PAC] }, null)).toBeNull();
    expect(sectionGeometry({ st: [ERC] }, DISTRICT)).toBeNull();
    expect(sectionGeometry(undefined, DISTRICT)).toBeNull();
  });
});

describe('toFeatures', () => {
  test('draws one band per structured section and rings its stations', () => {
    // Arrange
    const payload = payloadOf([CLOSURE]);

    // Act
    const built = toFeatures(payload, context());

    // Assert
    expect(built.live).toHaveLength(1);
    expect(built.live[0]?.geometry.type).toBe('MultiLineString');
    expect(built.sectionsDrawn).toBe(1);
    expect(built.sectionsDroppedMissingHop).toBe(0);
    // The cause point is structured too, so it survives on its own merits.
    expect(built.liveStations.some((f) => f.properties?.role === 'cause')).toBe(false);
    // Two endpoints; the cause point coincides with the mid station, which
    // already has a ring.
    expect(built.liveStations.map((f) => f.properties?.role)).toEqual(['end', 'end', 'mid']);
    expect(built.planned).toHaveLength(0);
  });

  test('drops a section with a missing hop, counts it, and draws nothing', () => {
    // Arrange — the same item, but the path steps onto an unconnected station.
    const broken: DisruptionItem = {
      ...CLOSURE,
      sec: [{ st: [WIM, ORPHAN], k: 'closed' }],
      pts: [],
    };

    // Act
    const built = toFeatures(payloadOf([broken]), context());

    // Assert
    expect(built.live).toHaveLength(0);
    expect(built.liveStations).toHaveLength(0);
    expect(built.sectionsDrawn).toBe(0);
    expect(built.sectionsDroppedMissingHop).toBe(1);
  });

  test('a line-scope item produces zero map features', () => {
    // Arrange — a whole-line minor-delays notice with no structured location.
    const lineWide: DisruptionItem = {
      id: 'district:aaaa:none',
      l: 'district',
      s: 9,
      d: 'Minor Delays',
      k: 'minor',
      c: 'R',
      sc: 'line',
      src: 'f',
      r: 'District Line: Minor delays due to an earlier signal failure.',
    };

    // Act
    const built = toFeatures(payloadOf([lineWide]), context());

    // Assert — a mark at a place would imply a place.
    expect(built.live).toHaveLength(0);
    expect(built.planned).toHaveLength(0);
    expect(built.liveStations).toHaveLength(0);
    expect(built.plannedStations).toHaveLength(0);
  });

  test('a parsed section never draws while pf is 0', () => {
    // Arrange — a section the backend flags as prose-derived.
    const parsed: DisruptionItem = { ...CLOSURE, src: 'p' };

    // Act
    const withFlagOff = toFeatures(payloadOf([parsed], 0), context());
    const withFlagOn = toFeatures(payloadOf([parsed], 1), context());

    // Assert
    expect(withFlagOff.live).toHaveLength(0);
    expect(withFlagOn.live).toHaveLength(1);
  });

  test('planned works go to their own source and name the co-corridor lines', () => {
    // Arrange — a weekend closure on track the Circle line also uses.
    const planned: DisruptionItem = {
      ...CLOSURE,
      c: 'P',
      n: 0,
      v: [{ f: '2026-09-05T02:30:00Z', t: '2026-09-07T00:29:00Z' }],
      sec: [{ st: [ERC, PAC], k: 'closed', dir: 'b' }],
    };

    // Act
    const built = toFeatures(payloadOf([planned]), context());

    // Assert
    expect(built.live).toHaveLength(0);
    expect(built.planned).toHaveLength(1);
    expect(built.planned[0]?.properties?.also).toBe('Circle');
    expect(built.plannedStations.length).toBeGreaterThan(0);
  });

  test('an Information notice that is not in force yet never joins the live source', () => {
    // Arrange — the real Waterloo & City timetable notice: category I, so
    // neither RealTime nor PlannedWork, and no window covering now. Judged by
    // category it counted as live and hatched the whole line closed on a
    // Friday morning while the line was running.
    const timetable: DisruptionItem = {
      ...CLOSURE,
      l: 'district',
      c: 'I',
      n: 0,
      s: 4,
      d: 'Planned Closure',
      v: [{ f: '2026-09-05T03:15:00Z', t: '2026-09-05T22:59:00Z' }],
    };

    // Act
    const built = toFeatures(payloadOf([timetable]), context());

    // Assert
    expect(built.live).toHaveLength(0);
    expect(built.liveStations).toHaveLength(0);
    expect(built.planned).toHaveLength(1);
  });

  test('a planned closure that has begun is drawn live, not hidden in the planned source', () => {
    // Arrange — the mirror of the bug above, and the worse half: on the
    // morning a weekend closure actually starts, category still says P. The
    // planned source is hidden by default, so the map would show nothing on
    // the one day the line is genuinely shut.
    const inForce: DisruptionItem = {
      ...CLOSURE,
      c: 'P',
      n: 1,
      v: [{ f: '2026-09-05T02:30:00Z', t: '2026-09-07T00:29:00Z' }],
    };

    // Act
    const built = toFeatures(payloadOf([inForce]), context());

    // Assert
    expect(built.live).toHaveLength(1);
    expect(built.planned).toHaveLength(0);
    expect(built.live[0]?.properties?.planned).toBe(false);
  });

  test('a planned work whose windows have all ended draws nothing', () => {
    // Arrange — the backend window opens yesterday, so finished works arrive.
    const over: DisruptionItem = {
      ...CLOSURE,
      c: 'P',
      n: 0,
      v: [{ f: '2026-08-29T02:30:00Z', t: '2026-08-31T00:29:00Z' }],
    };

    // Act
    const built = toFeatures(payloadOf([over]), context());

    // Assert
    expect(built.planned).toHaveLength(0);
    expect(built.live).toHaveLength(0);
  });

  test('a whole-line closure hatches every hop of the line', () => {
    // Arrange
    const wholeLine: DisruptionItem = {
      ...CLOSURE,
      s: 20,
      d: 'Service Closed',
      wl: 1,
      sec: [],
      pts: [],
    };

    // Act
    const built = toFeatures(payloadOf([wholeLine]), context());

    // Assert — both district hops, and no rings.
    expect(built.live).toHaveLength(1);
    expect(built.live[0]?.geometry).toMatchObject({ type: 'MultiLineString' });
    expect(built.liveStations).toHaveLength(0);
  });

  test('a minor-delays cause is popup text, never a pin', () => {
    // Arrange — severity 9 is below the pin threshold (spec §6.2).
    const minor: DisruptionItem = {
      ...CLOSURE,
      s: 9,
      k: 'minor',
      d: 'Minor Delays',
      sec: [],
      sc: 'line',
      pts: [{ id: PAC, role: 'cause' }],
    };

    // Act
    const built = toFeatures(payloadOf([minor]), context());

    // Assert
    expect(built.liveStations).toHaveLength(0);
  });
});

describe('currency', () => {
  const SERVER_T = 1_788_048_000;
  /** The server sent a body it had already held for 30 s. */
  const SERVER_AGE_MS = 30_000;
  const SENT_AT = new Date(SERVER_T * 1000 + SERVER_AGE_MS).toUTCString();
  /** This viewer's clock runs ten minutes fast. */
  const CLIENT_SKEW_MS = 600_000;
  const RECEIVED_AT = SERVER_T * 1000 + SERVER_AGE_MS + CLIENT_SKEW_MS;

  test('reads the server-side age from `t` and the response Date header', () => {
    expect(serverAgeMs(SERVER_T, SENT_AT)).toBe(SERVER_AGE_MS);
    // No header, or an unparseable one, must not invent an age.
    expect(serverAgeMs(SERVER_T, null)).toBe(0);
    expect(serverAgeMs(SERVER_T, 'not a date')).toBe(0);
  });

  test('a ten-minute-fast client clock still sees a fresh payload', () => {
    // Arrange — one minute of viewer time has passed since arrival.
    const arrival = { serverAgeMs: SERVER_AGE_MS, receivedAt: RECEIVED_AT };

    // Act
    const age = payloadAgeMs(arrival, RECEIVED_AT + 60_000);

    // Assert — comparing the viewer clock to `t` would have said 11.5 minutes.
    expect(age).toBe(90_000);
    expect(currencyOf(age)).toBe('fresh');
  });

  test('greys at five minutes and clears at ten, measured from arrival', () => {
    const arrival = { serverAgeMs: SERVER_AGE_MS, receivedAt: RECEIVED_AT };

    expect(currencyOf(payloadAgeMs(arrival, RECEIVED_AT + 4 * 60_000))).toBe('fresh');
    expect(currencyOf(payloadAgeMs(arrival, RECEIVED_AT + 5 * 60_000))).toBe('stale');
    expect(currencyOf(payloadAgeMs(arrival, RECEIVED_AT + 9 * 60_000))).toBe('stale');
    // Backend down for eleven minutes: nothing may stay drawn.
    expect(currencyOf(payloadAgeMs(arrival, RECEIVED_AT + 11 * 60_000))).toBe('expired');
  });

  test('a viewer clock that jumps backwards never rejuvenates a payload', () => {
    const arrival = { serverAgeMs: SERVER_AGE_MS, receivedAt: RECEIVED_AT };

    expect(payloadAgeMs(arrival, RECEIVED_AT - 3_600_000)).toBe(SERVER_AGE_MS);
  });

  test('a stale payload greys every band', () => {
    const built = toFeatures(payloadOf([CLOSURE]), context({ stale: true }));

    expect(built.live[0]?.properties?.stale).toBe(true);
  });
});

describe('disruptionPopupHtml', () => {
  test("escapes markup in the raw sentence and keeps apostrophes out of attributes", () => {
    // Arrange — a hostile sentence with a tag and an apostrophe. `esc` does
    // not escape `'`, so no attribute may ever be built from upstream text.
    const reason =
      "District Line: no service at Earl's Court <script>alert(1)</script> today.";
    const built = toFeatures(
      payloadOf([{ ...CLOSURE, r: reason }]),
      context(),
    );

    // Act
    const html = disruptionPopupHtml(
      built.live[0]?.properties as Parameters<typeof disruptionPopupHtml>[0],
    );

    // Assert
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain("Earl's Court");
    // The only attributes in the markup are ones this module writes itself.
    expect(html).not.toMatch(/=\s*"[^"]*'[^"]*"/);
  });

  test('a RealTime item shows "since HH:MM" and never an end time', () => {
    const built = toFeatures(payloadOf([CLOSURE]), context());
    const html = disruptionPopupHtml(
      built.live[0]?.properties as Parameters<typeof disruptionPopupHtml>[0],
    );

    expect(html).toContain('Since ');
    expect(html).toContain('LIVE');
    expect(html).not.toContain('–');
  });
});


// ── the snapshot's currency must reach the text surfaces, not just the map ──

describe('a stale snapshot on the Lines tab, the pips and the station popup', () => {
  const NAMES = new Map([['district', 'District']]);
  const COLORS = new Map([['district', '#007D32']]);
  const LINE_ITEM: DisruptionItem = {
    ...CLOSURE,
    sc: 'line',
    src: 'f',
    sec: [],
    pts: [],
    d: 'Severe Delays',
    k: 'severe',
  };

  const publish = (over: Partial<Parameters<typeof publishSnapshot>[0]> = {}): void =>
    publishSnapshot({
      items: [LINE_ITEM],
      names: NAMES,
      colors: COLORS,
      expired: false,
      stale: false,
      connectionLost: false,
      ...over,
    });

  test('a fresh snapshot says nothing about staleness anywhere', () => {
    // Arrange / Act
    publish();

    // Assert
    expect(linePip('district')?.title).toBe('Severe Delays');
  });

  test('a stale snapshot greys the legend pip and says so in its title', () => {
    publish({ stale: true });

    const pip = linePip('district');

    expect(pip?.title).toContain('may be stale');
    expect(pip?.color).toBe('#8a94a0');
  });

  test('a stale snapshot marks the station popup headline', () => {
    publish({ stale: true, items: [CLOSURE] });

    expect(stationDisruptionLines(ERC)[0]?.headline).toContain('may be stale');
  });

  test('a lost connection is distinguishable from a genuine all-clear', () => {
    // Arrange — nothing to draw either way; only the flag separates them.
    publish({ items: [], expired: true, connectionLost: true });

    // Assert
    expect(disruptionsConnectionLost()).toBe(true);
  });
});


// ── the real payload through the real geometry builder ──
//
// disruptions-live.json is a key-scrubbed capture of GET /api/disruptions taken
// against the live TfL feed on 2026-09-03, and data/branches/*.json is the
// geometry the browser actually holds. If a real section stops building here,
// the map has silently stopped drawing a real closure — which is the one
// failure this whole feature exists to prevent.

describe('every section of a real /api/disruptions payload builds geometry', () => {
  test('the capture still carries real disrupted sections to test with', () => {
    // A payload that went empty, or a glob that loaded no branch file, would
    // make the assertions below vacuous rather than green.
    expect((LIVE.items ?? []).length).toBeGreaterThan(0);
    expect(liveSections().length).toBeGreaterThan(0);
    for (const { lineId } of liveSections()) {
      expect(bakedBranchesFor(lineId)?.branches.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('sections producing geometry equals sections in the payload', () => {
    // Arrange
    const failures: string[] = [];

    // Act
    for (const { lineId, section } of liveSections()) {
      const geometry = sectionGeometry(section, bakedBranchesFor(lineId));
      if (geometry === null || geometry.length === 0) {
        failures.push(`${lineId}: ${(section.st ?? []).join(' > ')}`);
      }
    }

    // Assert — the failure list is the message, so a data gap names itself.
    expect(failures).toEqual([]);
    expect(liveSections().length - failures.length).toBe(liveSections().length);
  });

  test('every id of every real section is a stop of its own line', () => {
    const strays: string[] = [];
    for (const { lineId, section } of liveSections()) {
      const branches = bakedBranchesFor(lineId);
      const ids = new Set((branches?.branches ?? []).flatMap((b) => b.stops.map((s) => s.id)));
      for (const id of section.st ?? []) if (!ids.has(id)) strays.push(`${lineId}/${id}`);
    }

    expect(strays).toEqual([]);
  });
});
