// Per-direction track choice for bake-nr-graph.mjs.
//
// The station-pair adjacency and the undirected reference polyline come from
// the main baker. Here each pair (a, b) gets TWO polylines, one per direction
// of travel, found by Dijkstra over a DIRECTED view of the same way graph,
// restricted to a corridor around the reference polyline:
//
//   • an edge traversed against its way's OSM direction tag (oneway=yes,
//     railway:preferred_direction=forward/backward) costs WRONG_WAY_FACTOR ×
//     its length — discouraged, never forbidden, so single-track and wrongly
//     tagged lines still path;
//   • untagged edges are ranked by side, in the direction of travel (UK
//     trains keep left): clearly LEFT of the reference polyline costs its
//     length, ON the reference RIGHT_SIDE_FACTOR × its length, clearly RIGHT
//     of it RIGHT_SIDE_FACTOR² ×. Whichever direction has a track to its left
//     of the reference moves onto it; the other direction, for which the
//     reference IS the left track, is held on it by the on/right step rather
//     than left to a coin toss between two equally penalised tracks — so the
//     rule works whichever of the two tracks Dijkstra picked for the
//     reference.
//
// Why a per-metre factor and not the tube baker's flat RIGHT_SIDE_PENALTY_M
// (15 m) per edge: the NR graph's edges are raw OSM node gaps, 5 m on curves
// and 300 m on straights, so a per-edge constant would rank tracks by how
// densely a mapper noded them and a 2 km segment on a curve would collect
// thousands of metres of penalty. Per metre, the reference costs 2 % extra and
// the far side ~4 % (40 / 80 m on 2 km): enough to beat the equal-length
// parallel track (parallel tracks differ by < 1 % even round a 90° curve at
// 3.5 m spacing), far too little to justify a detour off the corridor.
//
// Endpoints: the directed path starts and ends where its track crosses the
// station's line (arc 0 and arc L of the reference), interpolated on the
// chosen track (its end first walked outwards along that same track) or, when
// the track has no OSM node beyond the line, extrapolated from its last node
// along the reference at the same lateral offset. So a
// train dwelling at a station sits on the track it arrived on, and two
// consecutive segments meet within a metre or two instead of both snapping
// back to the one track the station's snap node is on.

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);
const toXY = ([lon, lat]) => [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT];
const fromXY = ([x, y]) => [x / M_PER_DEG_LON, y / M_PER_DEG_LAT];

export const WRONG_WAY_FACTOR = 5; // cost multiple for running against a way's direction tag
export const RIGHT_SIDE_FACTOR = 1.02; // cost multiple per metre of untagged track not left of the reference
const KEEP_LEFT_MIN_M = 1.5; // lateral offset beyond which an edge is "left of" the reference (tracks are >= ~3 m apart)
export const CORRIDOR_M = 30; // half-width around the reference the directed search may use
// Twin-bore tunnels (Elizabeth line core, HS1, the Heathrow branch) run their
// two directions up to ~100 m apart, beyond CORRIDOR_M, and a parallel track
// can jog out of the corridor for a few tens of metres where the reference
// cuts a corner. Out to this wider band the search may still use track: free
// when its direction tag agrees with travel (a tagged bore is unambiguous),
// at WIDE_BAND_FACTOR when untagged — cheap enough for a short jog that
// keeps a direction on its own track, too dear to run along a different line.
export const TAGGED_CORRIDOR_M = 120;
const WIDE_BAND_FACTOR = 1.5;
const END_WIN_M = 150; // how far along the track from a station's line a path may start/end (OSM node gaps)
const ANCHOR_MIN_M = 1; // below this gap the path's own end node is close enough to the station line
const SAME_TRACK_M = 2.5; // lateral step that still counts as the same track when extending an end
const GRID_M = 250; // node grid cell, > CORRIDOR_M so a 3x3 neighbourhood covers the corridor

// Direction preference of one OSM way along its own node order: +1 trains run
// forward, -1 backward, 0 both ways or untagged (same reading as
// bake-osm-geometry.mjs). Only the directed per-direction pathing uses it —
// the baker's adjacency stays on the undirected graph.
export function wayDirection(tags) {
  if (!tags) return 0;
  if (tags.oneway === 'yes' || tags.oneway === 'true' || tags.oneway === '1') return 1;
  if (tags.oneway === '-1') return -1;
  const pref = tags['railway:preferred_direction'];
  if (pref === 'forward') return 1;
  if (pref === 'backward') return -1;
  return 0;
}

// ── binary min-heap over (cost, localIdx) ───────────────────────────────────
class MinHeap {
  constructor() {
    this.cost = [];
    this.node = [];
  }
  get size() {
    return this.cost.length;
  }
  push(c, n) {
    const { cost, node } = this;
    cost.push(c);
    node.push(n);
    let i = cost.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cost[p] <= cost[i]) break;
      [cost[p], cost[i]] = [cost[i], cost[p]];
      [node[p], node[i]] = [node[i], node[p]];
      i = p;
    }
  }
  pop() {
    const { cost, node } = this;
    const top = [cost[0], node[0]];
    const lastC = cost.pop();
    const lastN = node.pop();
    if (cost.length) {
      cost[0] = lastC;
      node[0] = lastN;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < cost.length && cost[l] < cost[m]) m = l;
        if (r < cost.length && cost[r] < cost[m]) m = r;
        if (m === i) break;
        [cost[m], cost[i]] = [cost[i], cost[m]];
        [node[m], node[i]] = [node[i], node[m]];
        i = m;
      }
    }
    return top;
  }
}

// ── reference polyline frame: arc length s and signed lateral offset ────────
// Lateral is positive LEFT of the reference's a→b direction. Beyond either
// end the first/last piece is extended, so s runs negative / past L there.
export function makeFrame(refLonLat) {
  const pts = refLonLat.map(toXY);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const L = cum[cum.length - 1];
  const last = pts.length - 2;

  function project([px, py]) {
    let best = null;
    for (let i = 0; i <= last; i++) {
      const [ax, ay] = pts[i];
      const dx = pts[i + 1][0] - ax;
      const dy = pts[i + 1][1] - ay;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const tRaw = ((px - ax) * dx + (py - ay) * dy) / (len * len);
      const t = Math.max(i === 0 ? -Infinity : 0, Math.min(i === last ? Infinity : 1, tRaw));
      const fx = ax + t * dx;
      const fy = ay + t * dy;
      const d = Math.hypot(px - fx, py - fy);
      if (!best || d < best.d) {
        const side = (px - fx) * -dy + (py - fy) * dx; // dot with the left normal
        best = { d, s: cum[i] + t * len, lateral: side >= 0 ? d : -d };
      }
    }
    return best ?? { d: 0, s: 0, lateral: 0 };
  }

  // Point at arc s (clamped) shifted `lateral` metres to the left.
  function offsetPoint(s, lateral) {
    const sc = Math.max(0, Math.min(L, s));
    let i = 0;
    while (i < last && cum[i + 1] < sc) i++;
    while (i < last && cum[i + 1] === cum[i]) i++;
    const [ax, ay] = pts[i];
    const dx = pts[i + 1][0] - ax;
    const dy = pts[i + 1][1] - ay;
    const len = Math.hypot(dx, dy) || 1;
    const t = (sc - cum[i]) / len;
    return fromXY([ax + t * dx + (-dy / len) * lateral, ay + t * dy + (dx / len) * lateral]);
  }

  return { L, project, offsetPoint, pts };
}

/** Spatial grid over graph nodes in planar metres. */
export function buildDirectionIndex(coords) {
  const xy = coords.map(toXY);
  const grid = new Map();
  for (let i = 0; i < xy.length; i++) {
    const k = `${Math.floor(xy[i][0] / GRID_M)}|${Math.floor(xy[i][1] / GRID_M)}`;
    let cell = grid.get(k);
    if (!cell) {
      cell = [];
      grid.set(k, cell);
    }
    cell.push(i);
  }
  return { xy, grid };
}

// Graph nodes within TAGGED_CORRIDOR_M of the reference and within END_WIN_M of its
// ends, with their (s, lateral) in the reference frame.
function corridorNodes(index, frame) {
  const { xy, grid } = index;
  const cells = new Set();
  const { pts } = frame;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[Math.min(i + 1, pts.length - 1)];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (GRID_M / 2)));
    for (let k = 0; k <= steps; k++) {
      const cx = Math.floor((ax + ((bx - ax) * k) / steps) / GRID_M);
      const cy = Math.floor((ay + ((by - ay) * k) / steps) / GRID_M);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cells.add(`${cx + dx}|${cy + dy}`);
    }
  }
  const nodes = new Map(); // graph idx -> { s, lateral }
  for (const key of [...cells].sort()) {
    for (const i of grid.get(key) ?? []) {
      const p = frame.project(xy[i]);
      if (Math.abs(p.lateral) > TAGGED_CORRIDOR_M) continue;
      if (p.s < -END_WIN_M || p.s > frame.L + END_WIN_M) continue;
      nodes.set(i, p);
    }
  }
  return nodes;
}

// Directed corridor Dijkstra. dir +1 = travel a→b (s increasing), -1 = b→a.
// Progress u = dir > 0 ? s : L - s; sources sit near u = 0, targets near u = L.
function directedPath(graph, frame, nodes, dir, refEnds) {
  const { adjLists, adjTags } = graph;
  const { L } = frame;
  const u = (p) => (dir > 0 ? p.s : L - p.s);
  const startWin = Math.max(END_WIN_M, dir > 0 ? refEnds.headU + 1 : refEnds.tailU + 1);
  const endWin = Math.max(END_WIN_M, dir > 0 ? refEnds.tailU + 1 : refEnds.headU + 1);

  const dist = new Map();
  const prev = new Map();
  const heap = new MinHeap();
  for (const [i, p] of nodes) {
    const ui = u(p);
    if (ui >= -END_WIN_M && ui <= startWin) {
      const c = Math.abs(ui);
      if (c < (dist.get(i) ?? Infinity)) {
        dist.set(i, c);
        prev.set(i, -1);
        heap.push(c, i);
      }
    }
  }
  let best = null;
  while (heap.size) {
    const [c, i] = heap.pop();
    if (c > (dist.get(i) ?? Infinity)) continue;
    if (best && c >= best.total) break;
    const pi = nodes.get(i);
    const ui = u(pi);
    if (ui >= L - endWin) {
      const total = c + Math.abs(L - ui);
      if (!best || total < best.total) best = { total, node: i };
    }
    const a = adjLists[i];
    const tags = adjTags[i];
    for (let j = 0; j < a.length; j += 2) {
      const to = a[j];
      const pt = nodes.get(to);
      if (!pt) continue;
      const w = a[j + 1];
      const tag = tags[j >> 1];
      const wide = Math.abs(pi.lateral) > CORRIDOR_M || Math.abs(pt.lateral) > CORRIDOR_M;
      let cost;
      if (tag < 0) cost = w * WRONG_WAY_FACTOR;
      else if (tag > 0) cost = w;
      else if (wide) cost = w * WIDE_BAND_FACTOR;
      else {
        const leftOfTravel = (dir * (pi.lateral + pt.lateral)) / 2;
        if (leftOfTravel >= KEEP_LEFT_MIN_M) cost = w;
        else if (leftOfTravel > -KEEP_LEFT_MIN_M) cost = w * RIGHT_SIDE_FACTOR;
        else cost = w * RIGHT_SIDE_FACTOR * RIGHT_SIDE_FACTOR;
      }
      const nc = c + cost;
      if (nc < (dist.get(to) ?? Infinity)) {
        dist.set(to, nc);
        prev.set(to, i);
        heap.push(nc, to);
      }
    }
  }
  if (!best) return null;
  const chain = [];
  for (let i = best.node; i !== -1; i = prev.get(i)) chain.push(i);
  chain.reverse();
  return chain;
}

// A chain may start (end) at a node well inside the segment: Dijkstra seeds
// every node by its distance from the station line, so it can enter a track
// mid-way. Before anchoring, walk the chain's end node outwards along its OWN
// track (neighbours at nearly the same lateral offset) until it crosses the
// station line, so the end stub follows real track rather than a straight
// extrapolation that may cut across other tracks.
function extendAlongTrack(chain, graph, nodes, u, towardsStart, L) {
  const out = [...chain];
  const seen = new Set(out);
  for (;;) {
    const end = towardsStart ? out[0] : out[out.length - 1];
    const ue = u(end);
    if (towardsStart ? ue <= 0 : ue >= L) return out;
    const le = nodes.get(end).lateral;
    const a = graph.adjLists[end];
    let pick = -1;
    let pickDiff = SAME_TRACK_M;
    for (let j = 0; j < a.length; j += 2) {
      const n = a[j];
      const p = nodes.get(n);
      if (!p || seen.has(n)) continue;
      if (towardsStart ? u(n) >= ue : u(n) <= ue) continue;
      const diff = Math.abs(p.lateral - le);
      if (diff < pickDiff) {
        pickDiff = diff;
        pick = n;
      }
    }
    if (pick < 0) return out;
    seen.add(pick);
    if (towardsStart) out.unshift(pick);
    else out.push(pick);
  }
}

// Clip / extend a node chain so it runs exactly from progress 0 to progress L.
function anchorEnds(chain, coords, nodes, frame, dir) {
  const { L } = frame;
  const u = (i) => (dir > 0 ? nodes.get(i).s : L - nodes.get(i).s);
  const sOf = (uu) => (dir > 0 ? uu : L - uu);
  const lerp = (i, j, target) => {
    const ui = u(i);
    const uj = u(j);
    const t = uj === ui ? 0 : (target - ui) / (uj - ui);
    const [x0, y0] = coords[i];
    const [x1, y1] = coords[j];
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  };
  let first = chain.findIndex((i) => u(i) > 0);
  let lastIdx = -1;
  for (let k = chain.length - 1; k >= 0; k--) {
    if (u(chain[k]) < L) {
      lastIdx = k;
      break;
    }
  }
  if (first < 0 || lastIdx < 0 || first > lastIdx) return null;
  const out = [];
  if (first > 0) out.push(lerp(chain[first - 1], chain[first], 0));
  else if (u(chain[0]) > ANCHOR_MIN_M) out.push(frame.offsetPoint(sOf(0), nodes.get(chain[0]).lateral));
  for (let k = first; k <= lastIdx; k++) out.push(coords[chain[k]]);
  if (lastIdx < chain.length - 1) out.push(lerp(chain[lastIdx], chain[lastIdx + 1], L));
  else if (L - u(chain[lastIdx]) > ANCHOR_MIN_M) {
    out.push(frame.offsetPoint(sOf(L), nodes.get(chain[lastIdx]).lateral));
  }
  return out;
}

/**
 * Both directions of one station pair.
 * @param graph   { coords, adjLists, adjTags } from the main baker
 * @param index   buildDirectionIndex(coords)
 * @param refPath undirected reference polyline oriented a→b ([lon,lat][])
 * @param refInner graph node indices of the reference's inner path (a→b)
 * @returns { fwd, rev, stats } — fwd runs a→b, rev runs b→a; either falls
 *          back to the (oriented) reference when the corridor search fails.
 */
export function directedPolys(graph, index, refPath, refInner) {
  const frame = makeFrame(refPath);
  const nodes = corridorNodes(index, frame);
  for (const i of refInner) if (!nodes.has(i)) nodes.set(i, frame.project(index.xy[i]));
  const headU = Math.max(0, nodes.get(refInner[0])?.s ?? 0);
  const tailU = Math.max(0, frame.L - (nodes.get(refInner[refInner.length - 1])?.s ?? frame.L));
  const refEnds = { headU, tailU };

  const one = (dir) => {
    const found = directedPath(graph, frame, nodes, dir, refEnds);
    const u = (i) => (dir > 0 ? nodes.get(i).s : frame.L - nodes.get(i).s);
    const chain =
      found &&
      extendAlongTrack(extendAlongTrack(found, graph, nodes, u, true, frame.L), graph, nodes, u, false, frame.L);
    const pts = chain && anchorEnds(chain, graph.coords, nodes, frame, dir);
    if (!pts || pts.length < 2) {
      return { pts: dir > 0 ? refPath : [...refPath].reverse(), fallback: true, wrongWayM: 0, chain: null };
    }
    let wrongWayM = 0;
    let wrongWayAt = null;
    for (let k = 1; k < chain.length; k++) {
      const a = graph.adjLists[chain[k - 1]];
      for (let j = 0; j < a.length; j += 2) {
        if (a[j] === chain[k] && graph.adjTags[chain[k - 1]][j >> 1] < 0) {
          if (!wrongWayAt) wrongWayAt = graph.coords[chain[k - 1]];
          wrongWayM += a[j + 1];
          break;
        }
      }
    }
    return { pts, fallback: false, wrongWayM, wrongWayAt, chain };
  };
  const fwd = one(1);
  const rev = one(-1);
  return { fwd, rev, corridorNodes: nodes.size, nodes };
}

// ── comparison helpers (planar metres) ──────────────────────────────────────
function distToPolyline(p, polyXY) {
  let best = Infinity;
  for (let i = 0; i < polyXY.length - 1; i++) {
    const [ax, ay] = polyXY[i];
    const dx = polyXY[i + 1][0] - ax;
    const dy = polyXY[i + 1][1] - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    const d = Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
    if (d < best) best = d;
  }
  return polyXY.length === 1 ? Math.hypot(p[0] - polyXY[0][0], p[1] - polyXY[0][1]) : best;
}

/** Points every `stepM` metres along a lon/lat polyline, as planar XY. */
export function samplePolyline(polyLonLat, stepM) {
  const xy = polyLonLat.map(toXY);
  const out = [xy[0]];
  let carry = 0;
  for (let i = 0; i < xy.length - 1; i++) {
    const [ax, ay] = xy[i];
    const dx = xy[i + 1][0] - ax;
    const dy = xy[i + 1][1] - ay;
    const len = Math.hypot(dx, dy);
    let t = stepM - carry;
    while (t < len) {
      out.push([ax + (dx * t) / len, ay + (dy * t) / len]);
      t += stepM;
    }
    carry = len - (t - stepM);
  }
  out.push(xy[xy.length - 1]);
  return out;
}

/** Distances from samples along `a` (every stepM) to polyline `b`, metres. */
export function separationSamples(a, b, stepM = 10) {
  const bXY = b.map(toXY);
  return samplePolyline(a, stepM).map((p) => distToPolyline(p, bXY));
}

/** True when the two polylines stay within tolM of each other everywhere. */
export function sameTrack(a, b, tolM) {
  return (
    Math.max(...separationSamples(a, b, 5)) <= tolM && Math.max(...separationSamples(b, a, 5)) <= tolM
  );
}
