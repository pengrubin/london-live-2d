// Dubai rail catalogue for scripts/bake-osm-rail.mjs.
//
// The relation ids are pinned deliberately rather than discovered by query.
// Discovery is where the traps are: OpenStreetMap carries a Blue Line tagged
// `proposed:route=subway` whose stations are mapped as though operational, and
// route_master relations are invisible to bounding-box queries (their members
// are relations, which have no geometry of their own). An explicit catalogue
// says exactly what this region ships and cannot silently acquire an unbuilt
// line when someone edits OSM.

export default {
  name: 'Dubai',

  /**
   * Published service parameters, used to SIMULATE trains where no operator
   * publishes live positions. Every number here is public and sourced; nothing
   * is invented. A region that omits this block simply has no simulated
   * trains — the frontend derives the layer from the data, not from a flag.
   *
   * Local time is UTC+4 year-round (no daylight saving).
   * Hours: 05:00-24:00 Mon-Thu and Sat, to 01:00 Fri, from 08:00 Sun.
   */
  service: {
    utcOffsetHours: 4,
    // Index 0 = Sunday, matching Date#getUTCDay.
    hours: [
      { open: 8, close: 24 }, // Sun
      { open: 5, close: 24 }, // Mon
      { open: 5, close: 24 }, // Tue
      { open: 5, close: 24 }, // Wed
      { open: 5, close: 24 }, // Thu
      { open: 5, close: 25 }, // Fri — 01:00 next day
      { open: 5, close: 24 }, // Sat
    ],
    /** Local hours counted as peak, when the shorter headway applies. */
    peakHours: [[7, 10], [17, 21]],
  },
  /** Sanity bound: every baked coordinate must fall inside this. */
  bbox: { minLon: 54.8, minLat: 24.7, maxLon: 55.7, maxLat: 25.5 },

  lines: [
    {
      id: 'red',
      name: 'Red Line',
      mode: 'subway',
      // Present on the route_master and on all four route relations.
      color: '#CC0000',
      // ONE physical line, TWO southern branches, each mapped in two
      // directions. Taking Red1-forward with Red2-REVERSE is deliberate: those
      // two share the three trunk ways (206373167, 206379003, 350264452), so
      // deduplicating by way id draws the Centrepoint→Jebel Ali trunk once.
      // Pairing the two *forward* relations instead shares zero ways — they
      // run on the parallel tracks, 0.4–48 m apart — and would draw the trunk
      // twice.
      //
      // Order matters: the first relation is stitched whole, later ones
      // contribute only the ways the earlier ones did not use.
      // 52.5 km main section end to end in ~70 min → 45 km/h including dwells.
      sim: { speedKmh: 45, headwayPeakS: 180, headwayOffPeakS: 360 },
      relations: [
        { id: 420297, note: 'Red1 forward: Centrepoint → Expo City Dubai' },
        { id: 12820285, note: 'Red2 reverse: Centrepoint → UAE Exchange' },
      ],
    },
    {
      id: 'green',
      name: 'Green Line',
      mode: 'subway',
      color: '#00CC00',
      sim: { speedKmh: 45, headwayPeakS: 180, headwayOffPeakS: 300 },
      relations: [{ id: 2767663, note: 'Green forward: Etisalat → Creek' }],
    },
    {
      id: 'palm',
      name: 'Palm Jumeirah Monorail',
      mode: 'monorail',
      // OSM's route_master says colour=#000000, which is a placeholder rather
      // than a brand colour and is invisible on a dark basemap. Chosen here.
      color: '#E8A33D',
      // 5.1 km in about 11 min; runs far less often than the metro.
      sim: { speedKmh: 28, headwayPeakS: 900, headwayOffPeakS: 1200 },
      relations: [{ id: 7825237, note: 'Palm Jumeirah Monorail' }],
    },
    {
      id: 'tram',
      name: 'Dubai Tram',
      mode: 'tram',
      // No colour anywhere in OSM: not on the route relation, and the tram has
      // no route_master to inherit from.
      color: '#2E86DE',
      // The tram's members carry roles `forward` (×27) and `backward` (×1) —
      // none is empty. Selecting empty roles yields an empty line; including
      // `backward` splices in a 30 m dead-end stub that is the only genuine
      // gap in the whole dataset.
      wayRoles: ['forward'],
      // 12.6 km of baked geometry in the published ~40 min → 19 km/h.
      sim: { speedKmh: 19, headwayPeakS: 240, headwayOffPeakS: 420 },
      relations: [{ id: 7826083, note: 'Dubai Tram (out-and-back loop)' }],
    },
  ],

  /**
   * Stations OSM cannot resolve to a single `railway=station` node, keyed by
   * the stop_position node id it must fall back to. All tram stops and four
   * Palm stops have no station node at all; these are handled generically by
   * the name-dedupe fallback, so nothing is listed here — the field exists to
   * document that the fallback is expected, not exceptional.
   */
  stationOverrides: {},
};
