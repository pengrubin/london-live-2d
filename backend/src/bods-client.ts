// Live bus positions from the DfT Bus Open Data Service (BODS) SIRI-VM
// datafeed. Polls the configured bounding box every 15 s (all-London is ~7.5 MB
// XML, ~8-9k vehicles), parses it with a fast string scan (no DOM), and keeps an
// in-memory vehicle table the /api/buses route serves as a compact array.

import { bboxToString, type Bbox } from './region';

const BODS_BASE_URL = 'https://data.bus-data.dft.gov.uk/api/v1/datafeed/';
const POLL_INTERVAL_MS = 15_000;
/** The feed is big; give the download room to breathe. */
const FETCH_TIMEOUT_MS = 30_000;
const STALE_AFTER_MS = 5 * 60_000;

export interface Bus {
  /** operator-qualified vehicle id ("SULV:LX24ABC") — VehicleRef alone collides across operators */
  readonly id: string;
  readonly line: string;
  readonly operator: string;
  /** normalized DirectionRef: "outbound" | "inbound" | lowercased raw | "unknown" */
  readonly direction: string;
  readonly dest: string;
  readonly lat: number;
  readonly lon: number;
  /** degrees clockwise from north; null when the feed omits Bearing */
  readonly bearing: number | null;
  /** RecordedAtTime as epoch ms */
  readonly recordedAt: number;
}

/** Wire format for /api/buses — short keys, ~9k rows, keep the payload lean. */
export interface BusWire {
  readonly i: string;
  readonly l: string;
  readonly o: string;
  /** normalized direction — pairs with `o`+`l` to address a learned route */
  readonly r: string;
  readonly d: string;
  readonly x: number;
  readonly y: number;
  readonly b: number | null;
  readonly t: number;
}

/**
 * A string that shares no storage with the one it came from.
 *
 * V8's `slice`/`split` do not copy: they return a view that keeps a pointer to
 * the WHOLE parent string. Every field below is cut out of a ~7 MB SIRI
 * document, so one retained route number or destination name pins the entire
 * poll's XML — and those fields are retained, in the vehicle table, the wire
 * buffer and the diversion event store.
 *
 * That is what killed the London service on 2026-09-04: a heap snapshot of the
 * reproduction showed 66 SIRI bodies, 480 MB of a 673 MB heap, held by nothing
 * larger than a bus destination. The heap grew ~690 MB/h until it hit V8's
 * 2 GB ceiling, and the final Mark-Compact freed 0.6 MB because none of it was
 * garbage.
 *
 * Buffer round-trip rather than a `slice` trick: it decodes bytes into a fresh
 * flat string with no parent, which is the property being bought, and it says
 * so plainly. Cost is ~5 fields x ~6,700 vehicles per poll of very short
 * strings, against a parse that already takes 60-120 ms.
 */
function copyOut(text: string): string {
  return text.length === 0 ? '' : Buffer.from(text, 'utf8').toString('utf8');
}

/** First `<tag>…</tag>` text inside `chunk`, or '' — indexOf scan, no regex.
 * The result is copied out of `chunk`; see `copyOut`. */
function tagText(chunk: string, tag: string): string {
  const open = `<${tag}>`;
  const start = chunk.indexOf(open);
  if (start === -1) return '';
  const from = start + open.length;
  const end = chunk.indexOf(`</${tag}>`, from);
  if (end === -1) return '';
  return copyOut(chunk.slice(from, end));
}

/** SIRI names use underscores for spaces ("Bus_Station"); undo for display. */
function humanize(name: string): string {
  return name.replaceAll('_', ' ').trim();
}

/**
 * Normalizes SIRI DirectionRef across publishers: TfL uses "1"/"2"
 * (1 = outbound, 2 = inbound), most others "outbound"/"inbound".
 */
export function normalizeDirection(raw: string): string {
  const dir = raw.trim().toLowerCase();
  if (dir === '' ) return 'unknown';
  if (dir === '1') return 'outbound';
  if (dir === '2') return 'inbound';
  return dir;
}

/**
 * Parses a SIRI-VM document into buses, dropping entries older than
 * `STALE_AFTER_MS` and entries without a usable position.
 */
export function parseSiriVm(xml: string, now: number): Bus[] {
  const cutoff = now - STALE_AFTER_MS;
  const chunks = xml.split('<VehicleActivity>');
  const buses: Bus[] = [];
  // chunks[0] is the document header — skip it.
  for (let i = 1; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (chunk === undefined) continue; // noUncheckedIndexedAccess appeasement
    const recordedAt = Date.parse(tagText(chunk, 'RecordedAtTime'));
    if (!Number.isFinite(recordedAt) || recordedAt < cutoff) continue;
    const lon = Number.parseFloat(tagText(chunk, 'Longitude'));
    const lat = Number.parseFloat(tagText(chunk, 'Latitude'));
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const operator = tagText(chunk, 'OperatorRef');
    const vehicleRef = tagText(chunk, 'VehicleRef');
    if (vehicleRef === '') continue;
    const rawBearing = Number.parseFloat(tagText(chunk, 'Bearing'));
    buses.push({
      id: `${operator}:${vehicleRef}`,
      line: tagText(chunk, 'PublishedLineName') || tagText(chunk, 'LineRef'),
      operator,
      direction: normalizeDirection(tagText(chunk, 'DirectionRef')),
      dest: humanize(tagText(chunk, 'DestinationName')),
      lat,
      lon,
      bearing: Number.isFinite(rawBearing) ? rawBearing : null,
      recordedAt,
    });
  }
  return buses;
}

export class BodsClient {
  private vehicles = new Map<string, Bus>();
  private wire: BusWire[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly apiKey: string;
  private readonly log: (msg: string) => void;
  private readonly boundingBox: string;
  /** Optional trace sink — receives every poll's fixes for route learning. */
  private readonly traceSink: ((buses: readonly Bus[], now: number) => void) | undefined;

  constructor(
    apiKey: string,
    bbox: Bbox,
    log: (msg: string) => void,
    traceSink?: (buses: readonly Bus[], now: number) => void,
  ) {
    this.apiKey = apiKey;
    this.boundingBox = bboxToString(bbox);
    this.log = log;
    this.traceSink = traceSink;
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Compact snapshot for /api/buses, rebuilt once per successful poll. */
  list(): BusWire[] {
    return this.wire;
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // a slow download must not stack requests
    this.polling = true;
    try {
      const url = `${BODS_BASE_URL}?boundingBox=${this.boundingBox}&api_key=${this.apiKey}`;
      // note: no accept header — BODS answers 406 to `accept: application/xml`
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        this.log(`BODS poll failed: HTTP ${response.status}`);
        return;
      }
      const xml = await response.text();
      const parseStart = performance.now();
      const buses = parseSiriVm(xml, Date.now());
      const table = new Map<string, Bus>();
      for (const bus of buses) {
        const prev = table.get(bus.id);
        if (prev === undefined || prev.recordedAt < bus.recordedAt) table.set(bus.id, bus);
      }
      this.vehicles = table;
      this.wire = [...table.values()].map((v) => ({
        i: v.id,
        l: v.line,
        o: v.operator,
        r: v.direction,
        d: v.dest,
        x: v.lon,
        y: v.lat,
        b: v.bearing,
        t: v.recordedAt,
      }));
      // Buffer-only call (no IO) — must never block or fail the poll loop.
      try {
        this.traceSink?.([...table.values()], Date.now());
      } catch (err) {
        this.log(`trace sink error: ${String(err)}`);
      }
      const parseMs = Math.round(performance.now() - parseStart);
      this.log(`BODS poll: ${table.size} vehicles, parse ${parseMs} ms`);
    } catch (err) {
      this.log(`BODS poll error: ${String(err)}`);
    } finally {
      this.polling = false;
    }
  }
}
