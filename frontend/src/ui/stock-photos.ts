// Bundled rolling-stock photos: one representative CC-licensed exterior shot
// per line's current fleet, imported as Vite static assets so train detail
// cards render them instantly from the bundle (no network fetch). Sources,
// licenses and authors are recorded in docs/PHOTO_CREDITS.md.
//
// Keys are REGION-QUALIFIED because line ids are only unique within a region:
// `tram` is Croydon in London and the Al Sufouh line in Dubai, and an
// unqualified table would show one city's rolling stock for the other's. The
// region comes from the active capabilities, so callers still pass just a line
// id — the same call serves real trains and simulated ones.

import stock1972 from '../assets/stock/stock-1972.jpg';
import stock1992 from '../assets/stock/stock-1992.jpg';
import stock1995 from '../assets/stock/stock-1995.jpg';
import stock1996 from '../assets/stock/stock-1996.jpg';
import stock2009 from '../assets/stock/stock-2009.jpg';
import stock2024 from '../assets/stock/stock-2024.jpg';
import stockS from '../assets/stock/stock-s.jpg';
import class345 from '../assets/stock/class-345.jpg';
import class710 from '../assets/stock/class-710.jpg';
import dlrB23 from '../assets/stock/dlr-b23.jpg';
import tramVariobahn from '../assets/stock/tram-variobahn.jpg';
import cableCar from '../assets/stock/cable-car.jpg';
import dubaiMetroRed from '../assets/stock/dubai-metro-red.jpg';
import dubaiMetroGreen from '../assets/stock/dubai-metro-green.jpg';
import dubaiTram from '../assets/stock/dubai-tram.jpg';
import dubaiMonorail from '../assets/stock/dubai-monorail.jpg';
import { region } from '../region';

/** "<region>:<lineId>" → bundled photo of that line's rolling stock. */
const STOCK_PHOTO_BY_LINE: Readonly<Record<string, string>> = {
  'london:bakerloo': stock1972, // 1972 Stock
  'london:central': stock1992, // 1992 Stock
  'london:waterloo-city': stock1992, // 1992 Stock
  'london:northern': stock1995, // 1995 Stock
  'london:jubilee': stock1996, // 1996 Stock
  'london:victoria': stock2009, // 2009 Stock
  'london:piccadilly': stock2024, // 2024 Stock
  'london:circle': stockS, // S7 Stock
  'london:district': stockS, // S7 Stock
  'london:hammersmith-city': stockS, // S7 Stock
  'london:metropolitan': stockS, // S8 Stock
  'london:elizabeth': class345, // Class 345
  'london:dlr': dlrB23, // B23 Stock
  'london:liberty': class710, // Class 710
  'london:lioness': class710, // Class 710
  'london:mildmay': class710, // Class 710
  'london:suffragette': class710, // Class 710
  'london:weaver': class710, // Class 710
  'london:windrush': class710, // Class 710
  'london:tram': tramVariobahn, // Stadler Variobahn
  'london:london-cable-car': cableCar, // cable car cabins

  'dubai:red': dubaiMetroRed,
  'dubai:green': dubaiMetroGreen,
  'dubai:tram': dubaiTram, // Alstom Citadis 402 — NOT Croydon's Variobahn
  'dubai:palm': dubaiMonorail,
};

/**
 * Bundled rolling-stock photo for a line of the ACTIVE region, or null.
 *
 * The region name is read here rather than passed in so every caller stays a
 * one-argument lookup. A region whose name is changed loses its photos, which
 * is cosmetic and visible immediately — preferable to a fallback that would
 * quietly hand one city another city's trains.
 */
export function stockPhotoUrl(lineId: string): string | null {
  return STOCK_PHOTO_BY_LINE[`${region().name.toLowerCase()}:${lineId}`] ?? null;
}
