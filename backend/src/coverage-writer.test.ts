import { describe, expect, test } from 'vitest';
import {
  assignBucket,
  buildCoverageArtifact,
  computeRollingMeans,
  quantizePolyline,
  selectWindowDays,
  simplifyPolyline,
  type LonLat,
} from './coverage-writer';

// ~11.13 m per 0.0001° of latitude — offsets with a known metric size.
const LAT_51_5 = 51.5;
// Same projection constants as the corridor pass (fixed London latitude).
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((51.5 * Math.PI) / 180);

/** North-south line through metric offsets — bearings 0°/180°, so match
 * distances between routes are pure longitude offsets in metres. */
const latAt = (metres: number): number => LAT_51_5 + metres / M_PER_DEG_LAT;
const lonAt = (metres: number): number => -0.1 + metres / M_PER_DEG_LON;
const nsLine = (fromM: number, toM: number, lonOffsetM = 0): LonLat[] => [
  [lonAt(lonOffsetM), latAt(fromM)],
  [lonAt(lonOffsetM), latAt(toM)],
];

describe('simplifyPolyline', () => {
  test('always preserves the endpoints', () => {
    const poly: LonLat[] = [
      [-0.1, LAT_51_5],
      [-0.1005, LAT_51_5],
      [-0.101, LAT_51_5],
    ];

    const out = simplifyPolyline(poly, 5);

    expect(out[0]).toEqual([-0.1, LAT_51_5]);
    expect(out[out.length - 1]).toEqual([-0.101, LAT_51_5]);
  });

  test('drops a collinear interior point', () => {
    const out = simplifyPolyline(
      [
        [-0.1, LAT_51_5],
        [-0.1005, LAT_51_5],
        [-0.101, LAT_51_5],
      ],
      5,
    );

    expect(out).toEqual([
      [-0.1, LAT_51_5],
      [-0.101, LAT_51_5],
    ]);
  });

  test('keeps an interior point deviating more than the tolerance', () => {
    // 0.0001° of latitude ≈ 11.1 m off the chord — above a 5 m tolerance
    const out = simplifyPolyline(
      [
        [-0.1, LAT_51_5],
        [-0.1005, LAT_51_5 + 0.0001],
        [-0.101, LAT_51_5],
      ],
      5,
    );

    expect(out).toHaveLength(3);
  });

  test('drops an interior point deviating less than the tolerance', () => {
    // 0.00002° of latitude ≈ 2.2 m off the chord — below a 5 m tolerance
    const out = simplifyPolyline(
      [
        [-0.1, LAT_51_5],
        [-0.1005, LAT_51_5 + 0.00002],
        [-0.101, LAT_51_5],
      ],
      5,
    );

    expect(out).toEqual([
      [-0.1, LAT_51_5],
      [-0.101, LAT_51_5],
    ]);
  });

  test('returns a two-point polyline unchanged', () => {
    const poly: LonLat[] = [
      [-0.1, LAT_51_5],
      [-0.2, 51.6],
    ];

    expect(simplifyPolyline(poly, 5)).toEqual(poly);
  });
});

describe('quantizePolyline', () => {
  test('rounds coordinates to 4 decimals', () => {
    const out = quantizePolyline([
      [-0.123456789, 51.987654321],
      [-0.100049, 51.100051],
    ]);

    expect(out).toEqual([
      [-0.1235, 51.9877],
      [-0.1, 51.1001],
    ]);
  });
});

describe('assignBucket', () => {
  test('assigns the largest absolute lower bound met, edges inclusive', () => {
    // exact edge values land IN the bucket they open
    expect(assignBucket(0)).toBe(0);
    expect(assignBucket(10)).toBe(1);
    expect(assignBucket(30)).toBe(2);
    expect(assignBucket(75)).toBe(3);
    expect(assignBucket(150)).toBe(4);
    expect(assignBucket(300)).toBe(5);
  });

  test('values just under an edge stay in the bucket below', () => {
    expect(assignBucket(9.99)).toBe(0);
    expect(assignBucket(29.9)).toBe(1);
    expect(assignBucket(74.5)).toBe(2);
    expect(assignBucket(149.9)).toBe(3);
    expect(assignBucket(299.9)).toBe(4);
  });

  test('is unbounded above and clamps below', () => {
    expect(assignBucket(10_000)).toBe(5);
    expect(assignBucket(0.4)).toBe(0);
  });
});

describe('selectWindowDays', () => {
  const NOW = Date.UTC(2026, 7, 28, 12); // 2026-08-28T12:00Z

  test('takes the newest 7 completed days, skipping the current UTC day', () => {
    const files = [
      '2026-08-28.json', // today — still growing, must be excluded
      '2026-08-27.json',
      '2026-08-26.json',
      '2026-08-25.json',
      '2026-08-24.json',
      '2026-08-23.json',
      '2026-08-22.json',
      '2026-08-21.json',
      '2026-08-20.json', // 8th completed day — outside the window
    ];

    const days = selectWindowDays(files, NOW);

    expect(days).toEqual([
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
    ]);
  });

  test('ignores non-day filenames and tmp leftovers', () => {
    const days = selectWindowDays(
      ['not-a-day.json', '2026-08-20.json.tmp', '2026-08-20.json'],
      NOW,
    );

    expect(days).toEqual(['2026-08-20']);
  });

  test('returns fewer days when fewer completed rollups exist', () => {
    const days = selectWindowDays(['2026-08-26.json', '2026-08-27.json'], NOW);

    expect(days).toEqual(['2026-08-26', '2026-08-27']);
  });
});

describe('computeRollingMeans', () => {
  test('divides by the full window so absent days count as zero', () => {
    const means = computeRollingMeans([
      new Map([
        ['TFLO_88_outbound', 10],
        ['GOAH_x80_inbound', 4],
      ]),
      new Map([['TFLO_88_outbound', 20]]),
    ]);

    expect(means.get('TFLO_88_outbound')).toBe(15);
    expect(means.get('GOAH_x80_inbound')).toBe(2); // 4 over 2 days, not 4 over 1
  });
});

describe('buildCoverageArtifact (corridor merge)', () => {
  test('carries day and windowDays as foreign members', async () => {
    const artifact = await buildCoverageArtifact(
      new Map([['R0', nsLine(0, 200)]]),
      new Map([['R0', 20]]),
      '2026-08-27',
      7,
    );

    expect(artifact.type).toBe('FeatureCollection');
    expect(artifact.day).toBe('2026-08-27');
    expect(artifact.windowDays).toBe(7);
  });

  test('merges two identical polylines into one corridor with summed j', async () => {
    const artifact = await buildCoverageArtifact(
      new Map([
        ['A', nsLine(0, 200)],
        ['B', nsLine(0, 200)],
      ]),
      new Map([
        ['A', 30],
        ['B', 20],
      ]),
      '2026-08-27',
      7,
    );

    expect(artifact.features).toHaveLength(1);
    const feature = artifact.features[0];
    expect(feature?.geometry.type).toBe('LineString');
    expect(feature?.properties).toEqual({ j: 50, b: 2 }); // 50 >= 30 → bucket 2
    // a straight 200 m corridor simplifies down to its two endpoints
    expect(feature?.geometry.coordinates).toHaveLength(2);
  });

  test('merges an antiparallel (reversed) polyline instead of duplicating it', async () => {
    const artifact = await buildCoverageArtifact(
      new Map([
        ['A_outbound', nsLine(0, 200)],
        ['A_inbound', nsLine(200, 0)], // same road, walked the other way
      ]),
      new Map([
        ['A_outbound', 30],
        ['A_inbound', 20],
      ]),
      '2026-08-27',
      7,
    );

    expect(artifact.features).toHaveLength(1);
    expect(artifact.features[0]?.properties).toEqual({ j: 50, b: 2 });
  });

  test('a route cannot add twice to one piece (out-and-back polyline)', async () => {
    // A → B → A: the return leg revisits every corridor piece the outbound
    // leg emitted; the guard must keep the total at one contribution.
    const lon = lonAt(0);
    const outAndBack: LonLat[] = [
      [lon, latAt(0)],
      [lon, latAt(210)],
      [lon, latAt(0)],
    ];

    const artifact = await buildCoverageArtifact(
      new Map([['loop', outAndBack]]),
      new Map([['loop', 20]]),
      '2026-08-27',
      7,
    );

    expect(artifact.features).toHaveLength(1);
    expect(artifact.features[0]?.properties).toEqual({ j: 20, b: 1 }); // not 40
  });

  test('drops routes whose rolling mean is 0 or missing', async () => {
    const artifact = await buildCoverageArtifact(
      new Map([
        ['zeroed', nsLine(0, 200, 0)],
        ['no_rollup_entry', nsLine(0, 200, 200)],
        ['alive', nsLine(0, 200, 400)],
      ]),
      new Map([
        ['zeroed', 0],
        ['alive', 5],
      ]),
      '2026-08-27',
      7,
    );

    expect(artifact.features).toHaveLength(1);
    expect(artifact.features[0]?.properties).toEqual({ j: 5, b: 0 });
  });

  test('splits an owner run where the corridor total changes bucket', async () => {
    // trunk covers 0..400 m at mean 20; branch overlaps only 200..400 m,
    // lifting that half to 35 — across the 30 journeys/day bucket edge.
    const artifact = await buildCoverageArtifact(
      new Map([
        ['trunk', nsLine(0, 400)],
        ['branch', nsLine(200, 400)],
      ]),
      new Map([
        ['trunk', 20],
        ['branch', 15],
      ]),
      '2026-08-27',
      7,
    );

    expect(artifact.features).toHaveLength(2);
    expect(artifact.features.map((f) => f.properties)).toEqual([
      { j: 20, b: 1 }, // 0..200 m: trunk alone
      { j: 35, b: 2 }, // 200..400 m: trunk + branch
    ]);
    // the split point sits at the 200 m mark on both features
    const splitLat = Number(latAt(200).toFixed(4));
    const first = artifact.features[0]?.geometry.coordinates;
    const second = artifact.features[1]?.geometry.coordinates;
    expect(first?.[first.length - 1]?.[1]).toBe(splitLat);
    expect(second?.[0]?.[1]).toBe(splitLat);
  });

  test('parallel lines 30 m apart stay separate corridors', async () => {
    const artifact = await buildCoverageArtifact(
      new Map([
        ['east', nsLine(0, 200, 0)],
        ['west', nsLine(0, 200, 30)], // 30 m > the 18 m match radius
      ]),
      new Map([
        ['east', 20],
        ['west', 20],
      ]),
      '2026-08-27',
      7,
    );

    expect(artifact.features).toHaveLength(2);
    for (const feature of artifact.features) {
      expect(feature.properties).toEqual({ j: 20, b: 1 });
    }
  });

  test('parallel lines 17 m apart merge into one corridor', async () => {
    // complement of the 30 m case: inside the 18 m radius, across whatever
    // grid cells the absolute coordinates land in (3×3 neighbourhood scan)
    const artifact = await buildCoverageArtifact(
      new Map([
        ['east', nsLine(0, 200, 0)],
        ['west', nsLine(0, 200, 17)],
      ]),
      new Map([
        ['east', 30],
        ['west', 20],
      ]),
      '2026-08-27',
      7,
    );

    expect(artifact.features).toHaveLength(1);
    expect(artifact.features[0]?.properties).toEqual({ j: 50, b: 2 });
  });

  test('a phase-shifted quieter route still adds to EVERY corridor piece', async () => {
    // Regression for the per-piece guard scope: B walks the same road as A
    // but resampled half a step out of phase, so each B piece sees BOTH the
    // corridor piece its previous B piece just touched (12.5 m behind, inside
    // the 18 m radius) and the untouched next one (12.5 m ahead). The guard
    // must only block the touched piece — suppressing the whole neighbourhood
    // would skip every other add and undercount the corridor (~j 41 not 60).
    const artifact = await buildCoverageArtifact(
      new Map([
        ['A', nsLine(0, 400)],
        ['B', nsLine(-12.5, 387.5)],
      ]),
      new Map([
        ['A', 40],
        ['B', 20],
      ]),
      '2026-08-27',
      7,
    );

    expect(artifact.features).toHaveLength(1);
    expect(artifact.features[0]?.properties).toEqual({ j: 60, b: 2 });
  });

  test('drops a corridor whose geometry collapses under 4-decimal rounding', async () => {
    // A 3 m stub rounds both endpoints onto the same 0.0001° grid point; a
    // one-position LineString is invalid GeoJSON and must not be emitted.
    const artifact = await buildCoverageArtifact(
      new Map([['stub', nsLine(0, 3)]]),
      new Map([['stub', 20]]),
      '2026-08-27',
      7,
    );

    expect(artifact.features).toHaveLength(0);
  });

  test('quantizes artifact coordinates to 4 decimals', async () => {
    const wobbly = new Map<string, LonLat[]>([
      [
        'R0',
        [
          [-0.123456789, 51.512345678],
          [-0.2, 51.6],
        ],
      ],
    ]);

    const artifact = await buildCoverageArtifact(wobbly, new Map([['R0', 1]]), '2026-08-27', 1);

    const coords = artifact.features.flatMap((f) => f.geometry.coordinates).flat();
    expect(coords.length).toBeGreaterThan(0);
    for (const value of coords) {
      expect(value).toBe(Number(value.toFixed(4)));
    }
  });
});
