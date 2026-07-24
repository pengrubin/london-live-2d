// Shared vessel-card helpers: lazy ship-photo fetch (via the backend
// VesselFinder proxy) and the dimensions line. Used by both the AIS ship
// popup (layers/vessels.ts) and the TfL boat detail card (ui/vehicle-popup.ts).

/** Photo object-URLs by MMSI; null = checked, no photo. Session-lifetime cache. */
const photoByMmsi = new Map<number, Promise<string | null>>();

/**
 * Resolves to a blob object-URL for the ship's photo, or null when the proxy
 * has none. One backend request per MMSI per session; the URL stays valid for
 * the page's lifetime so popups can re-render it freely.
 */
export function fetchShipPhoto(mmsi: number): Promise<string | null> {
  const cached = photoByMmsi.get(mmsi);
  if (cached) return cached;
  const pending = (async (): Promise<string | null> => {
    try {
      const res = await fetch(`/api/ship-photo?mmsi=${mmsi}`);
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) return null;
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  })();
  photoByMmsi.set(mmsi, pending);
  return pending;
}

/** `62 m × 12 m · 1.8 m draught` — omits whatever is missing; null if all are. */
export function dimensionsLine(
  lengthM: number | null | undefined,
  widthM: number | null | undefined,
  draughtM: number | null | undefined,
): string | null {
  const parts: string[] = [];
  if (lengthM && widthM) parts.push(`${lengthM}m × ${widthM}m`);
  else if (lengthM) parts.push(`${lengthM}m long`);
  if (draughtM) parts.push(`${draughtM}m draught`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Flag line for the card, or null when the MID prefix was unmapped. */
export function flagLine(flag: string | null | undefined): string | null {
  return flag && flag !== 'Unknown' ? `Flag: ${flag}` : null;
}
