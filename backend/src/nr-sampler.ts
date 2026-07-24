// National Rail sampler for the distance leaderboard: rotates one hub
// departure board per 15 s sample tick through the SAME cache + budget the
// /api/nr-board route uses (identical cache key: the uppercase CRS), so the
// sampler piggybacks on frontend polling and never double-spends the Darwin
// budget. Maintains rid-keyed train timelines and evaluates every known
// train's position at sample time (positions are pure functions of the clock,
// so distance accrues smoothly between board refreshes).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TtlCache } from './cache';
import type { AppConfig } from './config';
import type { RateBudget } from './rate-budget';
import { fetchNrBoard, type NrBoard } from './darwin-client';
import {
  mergeBoard,
  NrRailGraph,
  pruneTrains,
  trainPositionAt,
  type NrSegment,
  type NrStation,
  type NrTrackedTrain,
} from './shared/nr-inference';

/** Major boards to poll — same hub set the frontend map rotates through. */
const HUBS = ['WAT', 'VIC', 'LBG', 'LST', 'KGX', 'STP', 'EUS', 'PAD', 'MYB', 'CHX', 'CST', 'FST', 'MOG', 'BFR', 'CLJ', 'SRA', 'ECR'] as const;

/** Common TOC names → compact initials for leaderboard labels. */
const TOC_INITIALS: Record<string, string> = {
  'South Western Railway': 'SWR',
  Southeastern: 'SE',
  Southern: 'SN',
  Thameslink: 'TL',
  'Great Northern': 'GN',
  'Gatwick Express': 'GX',
  'Great Western Railway': 'GWR',
  'Greater Anglia': 'GA',
  'London North Eastern Railway': 'LNER',
  'Avanti West Coast': 'AWC',
  'East Midlands Railway': 'EMR',
  'West Midlands Railway': 'WMR',
  'London Northwestern Railway': 'LNR',
  'Chiltern Railways': 'CH',
  'Heathrow Express': 'HEX',
  CrossCountry: 'XC',
  'TransPennine Express': 'TPE',
  'London Overground': 'LO',
  'Elizabeth line': 'EL',
  'Elizabeth Line': 'EL',
  c2c: 'c2c',
  'Grand Central': 'GC',
  'Hull Trains': 'HT',
  Lumo: 'LUMO',
  ScotRail: 'SR',
  'Transport for Wales': 'TfW',
  'Caledonian Sleeper': 'CS',
};

/** "South Western Railway" → "SWR"; unmapped operators keep their full name. */
export function compactOperator(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'NR';
  return TOC_INITIALS[trimmed] ?? trimmed;
}

// ── cached board fetcher (shares the /api/nr-board cache + budget) ──

export interface NrBoardFetcherDeps {
  config: AppConfig;
  cache: TtlCache<unknown>;
  budget: RateBudget;
  log: (msg: string) => void;
}

/**
 * Board fetch through the SAME cache + budget as /api/nr-board (identical
 * cache key: the CRS code) — fresh cache hits are free, and upstream is only
 * touched when the cache has gone stale and Darwin budget remains.
 * Callers must only construct this when config.darwinToken is present.
 */
export function makeCachedNrBoardFetcher(deps: NrBoardFetcherDeps): (crs: string) => Promise<NrBoard | null> {
  const { config, cache, budget, log } = deps;
  const token = config.darwinToken;
  return async (crs: string): Promise<NrBoard | null> => {
    if (!token) return null;
    const fresh = cache.getFresh(crs);
    if (fresh !== undefined) return fresh as NrBoard;
    if (!budget.tryConsume()) {
      const stale = cache.getStale(crs);
      return stale !== undefined ? (stale as NrBoard) : null;
    }
    try {
      const upstream = await fetchNrBoard(crs, token);
      if (upstream.status === 200) {
        cache.set(crs, upstream.body);
        return upstream.body as NrBoard;
      }
      log(`nr-sampler: Darwin board ${crs} returned HTTP ${upstream.status}`);
      return null;
    } catch (err) {
      log(`nr-sampler: Darwin board ${crs} fetch failed: ${String(err)}`);
      const stale = cache.getStale(crs);
      return stale !== undefined ? (stale as NrBoard) : null;
    }
  };
}

// ── graph loading ──

/** Reads data/nr/stations.json + segments.json; null disables NR ranking. */
export function loadNrGraph(dataDir: string, log: (msg: string) => void): NrRailGraph | null {
  try {
    const stations = JSON.parse(
      readFileSync(join(dataDir, 'nr', 'stations.json'), 'utf8'),
    ) as NrStation[];
    const segments = JSON.parse(
      readFileSync(join(dataDir, 'nr', 'segments.json'), 'utf8'),
    ) as NrSegment[];
    return new NrRailGraph(stations, segments);
  } catch (err) {
    log(`nr-sampler: rail graph unreadable, NR ranking disabled: ${String(err)}`);
    return null;
  }
}

// ── the sampler ──

export interface NrSampleRow {
  /** leaderboard entry id, "train:nr:{rid}" */
  id: string;
  /** "SWR → Woking" (compact operator, full-name fallback) */
  label: string;
  lat: number;
  lon: number;
}

export class NrSampler {
  private readonly trains = new Map<string, NrTrackedTrain>();
  private hubIndex = 0;
  private readonly graph: NrRailGraph;
  private readonly fetchBoard: (crs: string) => Promise<NrBoard | null>;

  constructor(graph: NrRailGraph, fetchBoard: (crs: string) => Promise<NrBoard | null>) {
    this.graph = graph;
    this.fetchBoard = fetchBoard;
  }

  /**
   * One sample tick: refresh the next hub board (round-robin), prune finished
   * journeys, then evaluate every live train's position at `now`.
   */
  async tick(now: number): Promise<readonly NrSampleRow[]> {
    const crs = HUBS[this.hubIndex]!;
    this.hubIndex = (this.hubIndex + 1) % HUBS.length;
    const board = await this.fetchBoard(crs);
    if (board) mergeBoard(this.trains, board, this.graph.stations, now);
    pruneTrains(this.trains, now);
    const rows: NrSampleRow[] = [];
    for (const train of this.trains.values()) {
      const pos = trainPositionAt(train, now, this.graph);
      if (!pos) continue;
      rows.push({
        id: `train:nr:${train.rid}`,
        label: `${compactOperator(train.operator)} → ${train.destination}`,
        lat: pos[1],
        lon: pos[0],
      });
    }
    return rows;
  }
}
