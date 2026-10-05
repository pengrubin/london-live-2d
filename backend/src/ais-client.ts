// Live vessel positions/names from aisstream.io over WebSocket. Maintains an
// in-memory table of ships on the London Thames so the frontend can attach a
// real vessel name to each TfL river-bus marker.

import { flagFromMmsi } from './mid-flags';
import type { Bbox } from './region';

const RECONNECT_DELAY_MS = 15_000;
const STALE_AFTER_MS = 10 * 60_000;
const PRUNE_INTERVAL_MS = 60_000;
// A half-open socket (peer gone without a FIN, NAT entry dropped) stays OPEN
// forever and never fires 'close', so silence is the only symptom. Equal to
// STALE_AFTER_MS on purpose: the Thames genuinely goes quiet at night, and a
// shorter threshold would reconnect-loop a healthy key; by the time the prune
// has emptied the table, reconnecting costs nothing.
const IDLE_RECONNECT_MS = STALE_AFTER_MS;
// Detection granularity only; a minute of slack on a 10-minute threshold.
const WATCHDOG_INTERVAL_MS = 60_000;
const AIS_URL = 'wss://stream.aisstream.io/v0/stream';

export interface Vessel {
  mmsi: number;
  name: string;
  lat: number;
  lon: number;
  /** speed over ground, knots */
  sog: number | null;
  /** course over ground, degrees */
  cog: number | null;
  /** AIS ship-type code (60s passenger, 70s cargo, 80s tanker, …) */
  shipType: number | null;
  /** declared destination port, from static data */
  destination: string | null;
  /** overall length in metres (Dimension A+B), from static data */
  lengthM: number | null;
  /** beam in metres (Dimension C+D), from static data */
  widthM: number | null;
  /** maximum static draught in metres, from static data */
  draughtM: number | null;
  /** flag state derived from the MMSI's MID prefix; 'Unknown' when unmapped */
  flag: string;
  lastSeen: number;
}

interface AisDimension {
  A?: number;
  B?: number;
  C?: number;
  D?: number;
}

interface AisMessage {
  MessageType?: string;
  MetaData?: {
    MMSI?: number;
    ShipName?: string;
    latitude?: number;
    longitude?: number;
  };
  Message?: {
    PositionReport?: { Sog?: number; Cog?: number };
    ShipStaticData?: {
      Type?: number;
      Destination?: string;
      Dimension?: AisDimension;
      MaximumStaticDraught?: number;
    };
  };
}

/** Sums a bow/stern (or port/starboard) dimension pair; null when unreported. */
function dimensionSum(a: number | undefined, b: number | undefined): number | null {
  const total = (a ?? 0) + (b ?? 0);
  return total > 0 ? total : null;
}

export class AisClient {
  private readonly vessels = new Map<number, Vessel>();
  private socket: WebSocket | null = null;
  private stopped = false;
  /** Bumped by every start()/retire/stop; handlers and timers from an older
   *  generation are no-ops, so a stale socket can't reconnect over a live one. */
  private generation = 0;
  private lastMessageAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly apiKey: string;
  private readonly log: (msg: string) => void;
  /** aisstream wants [[minLat, minLon], [maxLat, maxLon]] — lat before lon. */
  private readonly boundingBoxes: readonly (readonly (readonly number[])[])[];

  constructor(apiKey: string, bbox: Bbox, log: (msg: string) => void) {
    this.apiKey = apiKey;
    this.boundingBoxes = [
      [
        [bbox.minLat, bbox.minLon],
        [bbox.maxLat, bbox.maxLon],
      ],
    ];
    this.log = log;
    setInterval(() => this.prune(), PRUNE_INTERVAL_MS).unref();
  }

  start(): void {
    if (this.stopped) return;
    const gen = ++this.generation;
    const current = (): boolean => gen === this.generation;
    this.lastMessageAt = Date.now();
    this.watchdog ??= setInterval(() => this.checkIdle(), WATCHDOG_INTERVAL_MS).unref();
    let socket: WebSocket;
    try {
      socket = new WebSocket(AIS_URL);
    } catch (err) {
      this.log(`AIS connect failed: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (!current()) return;
      this.lastMessageAt = Date.now();
      this.log('AIS stream connected');
      socket.send(
        JSON.stringify({
          APIKey: this.apiKey,
          BoundingBoxes: this.boundingBoxes,
          FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      if (!current()) return;
      this.lastMessageAt = Date.now();
      void this.handleMessage(event.data);
    });
    socket.addEventListener('close', () => {
      if (!current()) return;
      this.log('AIS stream closed; reconnecting');
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      if (!current()) return;
      // Never close() a socket that hasn't finished connecting: undici treats
      // close-during-CONNECTING as "fail the connection", which fires 'error'
      // again — a synchronous mutual recursion that overflows the stack and
      // kills the process. A failed connect fires 'close' by itself, so the
      // reconnect in the close handler still runs.
      if (socket.readyState === WebSocket.OPEN) socket.close();
    });
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.socket?.close();
  }

  list(): Vessel[] {
    return [...this.vessels.values()];
  }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      const text =
        typeof data === 'string'
          ? data
          : data instanceof Blob
            ? await data.text()
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : '';
      if (!text) return;
      const msg = JSON.parse(text) as AisMessage;
      const meta = msg.MetaData;
      if (!meta?.MMSI || meta.latitude === undefined || meta.longitude === undefined) return;
      const report = msg.Message?.PositionReport;
      const staticData = msg.Message?.ShipStaticData;
      const prev = this.vessels.get(meta.MMSI);
      const dim = staticData?.Dimension;
      const draught = staticData?.MaximumStaticDraught;
      this.vessels.set(meta.MMSI, {
        mmsi: meta.MMSI,
        name: (meta.ShipName ?? '').trim() || (prev?.name ?? ''),
        lat: meta.latitude,
        lon: meta.longitude,
        sog: report?.Sog ?? prev?.sog ?? null,
        cog: report?.Cog ?? prev?.cog ?? null,
        shipType: staticData?.Type ?? prev?.shipType ?? null,
        destination: staticData?.Destination?.trim() || (prev?.destination ?? null),
        lengthM: dimensionSum(dim?.A, dim?.B) ?? prev?.lengthM ?? null,
        widthM: dimensionSum(dim?.C, dim?.D) ?? prev?.widthM ?? null,
        draughtM: draught !== undefined && draught > 0 ? draught : (prev?.draughtM ?? null),
        flag: flagFromMmsi(meta.MMSI),
        lastSeen: Date.now(),
      });
    } catch {
      // one malformed frame is not worth killing the stream over
    }
  }

  private prune(): void {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [mmsi, v] of this.vessels) {
      if (v.lastSeen < cutoff) this.vessels.delete(mmsi);
    }
  }

  private checkIdle(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const idleMs = Date.now() - this.lastMessageAt;
    if (idleMs < IDLE_RECONNECT_MS) return;
    this.log(`AIS stream idle for ${Math.round(idleMs / 1000)}s; reconnecting`);
    // Retire this socket first so its own 'close' (if it ever arrives) is
    // ignored, then reconnect ourselves: a dead peer's close handshake may
    // never complete in undici. Only close() when OPEN — never CONNECTING.
    this.generation++;
    socket.close();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const gen = this.generation;
    setTimeout(() => {
      if (gen === this.generation) this.start();
    }, RECONNECT_DELAY_MS).unref();
  }
}
