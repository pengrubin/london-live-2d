// The train marker: a bullet nose, straight body, rounded tail, drawn to a
// canvas and rotated to the direction of travel.
//
// Shared rather than duplicated so a train is the same shape wherever it comes
// from. The only permitted difference is `hollow`, which marks a position that
// was SIMULATED from a timetable rather than measured — same silhouette, so it
// still reads as a train, but unmistakably not filled in.

const ICON_PX = 36; // canvas width  (drawn at 2x, rendered at pixelRatio 2)
const ICON_PY = 64; // canvas height
const ICON_OUTLINE = '#ffffff';
/** Backdrop for hollow markers, so they stay legible over a line of the same colour. */
const HOLLOW_FILL = 'rgba(10,10,10,0.55)';

export interface BulletOptions {
  /** Outline only, over a dark backdrop — the marker for simulated positions. */
  readonly hollow?: boolean;
}

export function makeBulletIcon(color: string, options: BulletOptions = {}): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_PX;
  canvas.height = ICON_PY;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const w = ICON_PX;
  const h = ICON_PY;
  const inset = 4; // room for the outline stroke
  const left = inset;
  const right = w - inset;
  const bottom = h - inset;
  const noseTip = inset;
  const shoulder = h * 0.38; // where the straight body curves into the nose
  const rearR = (right - left) / 2.6; // rounded tail corners

  ctx.beginPath();
  ctx.moveTo(left, shoulder);
  // nose: two symmetric curves meeting at the tip
  ctx.quadraticCurveTo(left, noseTip + (shoulder - noseTip) * 0.25, w / 2, noseTip);
  ctx.quadraticCurveTo(right, noseTip + (shoulder - noseTip) * 0.25, right, shoulder);
  // body sides + rounded tail
  ctx.lineTo(right, bottom - rearR);
  ctx.quadraticCurveTo(right, bottom, right - rearR, bottom);
  ctx.lineTo(left + rearR, bottom);
  ctx.quadraticCurveTo(left, bottom, left, bottom - rearR);
  ctx.closePath();

  if (options.hollow) {
    ctx.fillStyle = HOLLOW_FILL;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = ICON_OUTLINE;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, w, h);
}
