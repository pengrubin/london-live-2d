// COPY of frontend/src/realtime/types.ts — keep in sync manually.
// Copied (not cross-imported) because the backend tsc config enables
// noUncheckedIndexedAccess, which the frontend sources are not written for.

/** One TfL Arrivals prediction (fields we consume). */
export interface Prediction {
  lineId: string;
  lineName?: string;
  vehicleId?: string;
  naptanId: string;
  stationName?: string;
  timeToStation: number; // seconds until arrival at naptanId
  currentLocation?: string;
  platformName?: string;
  direction?: string; // 'inbound' | 'outbound' | ''
  destinationName?: string;
  destinationNaptanId?: string;
  towards?: string;
}

/** Baked branch data (data/branches/<lineId>.json). */
export interface BranchStop {
  id: string;
  name: string;
  lon: number;
  lat: number;
}

export interface Branch {
  branchId: number;
  direction: 'inbound' | 'outbound';
  stops: BranchStop[];
  /** segments[i] is the track polyline from stops[i] to stops[i+1]. */
  segments: [number, number][][];
  /** runTimes[i] is the scheduled seconds from stops[i] to stops[i+1] (baked from TfL timetables). */
  runTimes?: (number | null)[];
}

export interface LineBranches {
  lineId: string;
  branches: Branch[];
}

/** A resolved train with a concrete map position. */
export interface Train {
  key: string;
  lineId: string;
  lineName: string;
  vehicleId?: string;
  nextStopId: string;
  nextStopName: string;
  timeToStation: number;
  /** epoch ms when this prediction was received (drives live countdowns) */
  receivedAt?: number;
  currentLocation: string;
  platformName: string;
  direction: string;
  destination: string;
  /** NaPTAN id of this train's own terminus (short workings end early) */
  destinationId?: string;
  lngLat: [number, number];
  /** bearing in degrees (0 = north, clockwise), for oriented markers */
  bearing: number;
  /** identity came from currentLocation, not a vehicleId (key is unstable) */
  synthetic: boolean;
  /** track polyline the train is currently on (prev stop → next stop); null if unplaceable */
  segment: [number, number][] | null;
  /** target position as a fraction of the segment's arc length (1 = at next stop) */
  segmentFrac: number;
  /** run time (s) used for the ratio — enables frame-level dead reckoning */
  runTimeS?: number;
  /** stable identity of the segment, for display continuity across polls */
  segmentKey: string;
}
