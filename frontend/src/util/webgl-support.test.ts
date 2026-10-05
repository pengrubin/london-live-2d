// Unit tests for the WebGL probe. Runs in vitest's default node environment
// (no jsdom): a factory-injected fake canvas stands in for the DOM.
import { describe, expect, test, vi } from 'vitest';
import { hasWebGL, type ProbeCanvas } from './webgl-support';

type ContextId = 'webgl2' | 'webgl';

function fakeCanvas(contexts: Partial<Record<ContextId, unknown>>): ProbeCanvas & {
  getContext: ReturnType<typeof vi.fn>;
} {
  return { getContext: vi.fn((id: ContextId) => contexts[id] ?? null) };
}

describe('hasWebGL', () => {
  test('returns true when a webgl2 context is available', () => {
    // Arrange
    const canvas = fakeCanvas({ webgl2: {} });

    // Act
    const result = hasWebGL(() => canvas);

    // Assert — webgl1 is never tried once webgl2 works
    expect(result).toBe(true);
    expect(canvas.getContext).toHaveBeenCalledTimes(1);
    expect(canvas.getContext).toHaveBeenCalledWith('webgl2');
  });

  test('falls back to webgl1 when webgl2 is unavailable', () => {
    const canvas = fakeCanvas({ webgl: {} });

    const result = hasWebGL(() => canvas);

    expect(result).toBe(true);
    expect(canvas.getContext).toHaveBeenNthCalledWith(1, 'webgl2');
    expect(canvas.getContext).toHaveBeenNthCalledWith(2, 'webgl');
  });

  test('returns false when neither context can be created', () => {
    const canvas = fakeCanvas({});

    expect(hasWebGL(() => canvas)).toBe(false);
    expect(canvas.getContext).toHaveBeenCalledTimes(2);
  });

  test('returns false when getContext throws (canvas-blocking extension)', () => {
    const canvas: ProbeCanvas = {
      getContext: () => {
        throw new Error('blocked');
      },
    };

    expect(hasWebGL(() => canvas)).toBe(false);
  });

  test('returns false when the canvas factory itself throws', () => {
    expect(
      hasWebGL(() => {
        throw new Error('no document');
      }),
    ).toBe(false);
  });

  test('releases the probe context via WEBGL_lose_context', () => {
    // Arrange
    const loseContext = vi.fn();
    const gl = { getExtension: vi.fn(() => ({ loseContext })) };
    const canvas = fakeCanvas({ webgl2: gl });

    // Act
    hasWebGL(() => canvas);

    // Assert
    expect(gl.getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  test('still returns true when WEBGL_lose_context is not supported', () => {
    const gl = { getExtension: vi.fn(() => null) };
    const canvas = fakeCanvas({ webgl: gl });

    expect(hasWebGL(() => canvas)).toBe(true);
  });
});
