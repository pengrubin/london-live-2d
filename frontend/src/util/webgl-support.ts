// WebGL availability probe, run before the map is constructed.
//
// MapLibre renders everything through WebGL. When the browser cannot create a
// context (hardware acceleration off, GPU on the blocklist, a canvas-blocking
// extension) the page used to be a silent black canvas — a user reported
// "just a black screen" in Chrome while Safari worked. Probing first lets the
// page say why, before any network traffic or poller starts.

/** Just the slice of HTMLCanvasElement the probe touches, so tests can fake it. */
export interface ProbeCanvas {
  getContext(contextId: 'webgl2' | 'webgl'): unknown;
}

const defaultCanvasFactory = (): ProbeCanvas => document.createElement('canvas');

interface LoseContextExtension {
  loseContext(): void;
}

/**
 * Free the probe's context right away: browsers cap live WebGL contexts per
 * page (~16 in Chrome) and the map is about to create its own.
 */
function releaseContext(context: unknown): void {
  const gl = context as { getExtension?: (name: string) => unknown };
  if (typeof gl.getExtension !== 'function') return;
  const ext = gl.getExtension('WEBGL_lose_context') as LoseContextExtension | null;
  ext?.loseContext();
}

/**
 * True when a WebGL2 or WebGL1 context can be created. The probe canvas is
 * never attached to the DOM, so on success nothing is left behind. Default
 * context attributes on purpose: `failIfMajorPerformanceCaveat` stays off, so
 * a software-rendered context still counts — slow beats a blank page.
 */
export function hasWebGL(createCanvas: () => ProbeCanvas = defaultCanvasFactory): boolean {
  try {
    const canvas = createCanvas();
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (context === null || context === undefined) return false;
    releaseContext(context);
    return true;
  } catch {
    // Some privacy extensions make getContext throw instead of returning null;
    // either way there is no usable context.
    return false;
  }
}
