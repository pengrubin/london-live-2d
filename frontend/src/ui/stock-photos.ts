// Bundled rolling-stock photos: one representative CC-licensed exterior shot
// per line's current fleet, imported as Vite static assets so train detail
// cards render them instantly from the bundle (no network fetch). Sources,
// licenses and authors are recorded in docs/PHOTO_CREDITS.md.

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

/** lineId → bundled photo URL of that line's rolling stock. */
const STOCK_PHOTO_BY_LINE: Readonly<Record<string, string>> = {
  bakerloo: stock1972, // 1972 Stock
  central: stock1992, // 1992 Stock
  'waterloo-city': stock1992, // 1992 Stock
  northern: stock1995, // 1995 Stock
  jubilee: stock1996, // 1996 Stock
  victoria: stock2009, // 2009 Stock
  piccadilly: stock2024, // 2024 Stock
  circle: stockS, // S7 Stock
  district: stockS, // S7 Stock
  'hammersmith-city': stockS, // S7 Stock
  metropolitan: stockS, // S8 Stock
  elizabeth: class345, // Class 345
  dlr: dlrB23, // B23 Stock
  liberty: class710, // Class 710
  lioness: class710, // Class 710
  mildmay: class710, // Class 710
  suffragette: class710, // Class 710
  weaver: class710, // Class 710
  windrush: class710, // Class 710
  tram: tramVariobahn, // Stadler Variobahn
  'london-cable-car': cableCar, // cable car cabins
};

/** Bundled rolling-stock photo URL for a line, or null when we have none. */
export function stockPhotoUrl(lineId: string): string | null {
  return STOCK_PHOTO_BY_LINE[lineId] ?? null;
}
