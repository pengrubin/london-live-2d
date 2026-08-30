// Unit tests for the learned-route store buses.ts owns: the case-folded index,
// the meter-space geometry inversion, and which fetch failures are allowed to
// be remembered. Line → file-key resolution lives in bus-route-shape.ts and is
// tested there. buses.ts value-imports maplibre-gl (Popup), so we stub that
// module to keep the test in the fast node environment — same pattern as
// ui/bus-filter.test.ts.
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ Popup: class {} }));

const { foldRouteIndex, loadRouteGeometry } = await import('./buses');

describe('foldRouteIndex', () => {
  test('keeps the served stems and a lowercased lookup beside them', () => {
    // Arrange + Act
    const index = foldRouteIndex(['TFLO_24_inbound', 'GOCH_Go2_outbound']);

    // Assert
    expect(index.stems.has('TFLO_24_inbound')).toBe(true);
    expect(index.folded.get('goch_go2_outbound')).toBe('GOCH_Go2_outbound');
  });

  test('keeps the first spelling when two stems differ only by case', () => {
    // Arrange + Act
    const index = foldRouteIndex(['GOCH_Go2_outbound', 'GOCH_go2_outbound']);

    // Assert — either is equally right; what matters is that it is stable
    expect(index.folded.get('goch_go2_outbound')).toBe('GOCH_Go2_outbound');
    expect(index.stems.size).toBe(2);
  });
});

describe('loadRouteGeometry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const okBody = {
    poly: [
      [-0.1, 51.5],
      [-0.11, 51.51],
    ],
  };

  /** A fetch whose Response carries `status`; `body` is what .json() yields. */
  const stubFetch = (body: unknown, status = 200): ReturnType<typeof vi.fn> => {
    const ok = status >= 200 && status < 300;
    const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  /** A fetch that rejects, as AbortSignal.timeout and an offline browser do. */
  const stubFailingFetch = (error: Error): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn(async () => {
      throw error;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  test('round-trips lon/lat through the meter-space cache', async () => {
    // Arrange — sub-metre coordinates: the inverse must be exact enough that
    // vertices land back on the same road, not merely nearby
    const poly = [
      [-0.143063, 51.495601],
      [0.000123, 51.2],
      [0.45, 51.770987],
    ];
    stubFetch({ poly, quality: { meanResidualM: 5.6 } });

    // Act
    const out = await loadRouteGeometry('TEST_roundtrip_outbound');

    // Assert
    expect(out).not.toBeNull();
    expect(out).toHaveLength(3);
    for (let i = 0; i < poly.length; i += 1) {
      expect(out![i][0]).toBeCloseTo(poly[i][0], 9);
      expect(out![i][1]).toBeCloseTo(poly[i][1], 9);
    }
  });

  test('passes an abort signal so a stalled origin cannot hang the selection', async () => {
    // Arrange
    const fetchMock = stubFetch(okBody);

    // Act
    await loadRouteGeometry('TEST_signal_inbound');

    // Assert
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('shares one fetch across concurrent callers for the same key', async () => {
    // Arrange
    const fetchMock = stubFetch(okBody);

    // Act
    const [a, b] = await Promise.all([
      loadRouteGeometry('TEST_shared_inbound'),
      loadRouteGeometry('TEST_shared_inbound'),
    ]);
    const c = await loadRouteGeometry('TEST_shared_inbound');

    // Assert — the cache is shared with the bus-snapping path; a second
    // request must never mean a second file off the origin
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(c).toEqual(a);
  });

  test('negative-caches a 404 — the learner never wrote that route', async () => {
    // Arrange
    const fetchMock = stubFetch(null, 404);

    // Act
    const first = await loadRouteGeometry('TEST_missing_inbound');
    const second = await loadRouteGeometry('TEST_missing_inbound');

    // Assert
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('retries after a timeout instead of blanking the route for the session', async () => {
    // Arrange — what AbortSignal.timeout throws
    stubFailingFetch(new DOMException('The operation was aborted.', 'TimeoutError'));

    // Act — the blip, then a later selection of the same line
    const first = await loadRouteGeometry('TEST_timeout_inbound');
    const retryMock = stubFetch(okBody);
    const second = await loadRouteGeometry('TEST_timeout_inbound');

    // Assert — one connectivity blip must not be permanent
    expect(first).toBeNull();
    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(2);
  });

  test('retries after a network error', async () => {
    // Arrange
    stubFailingFetch(new TypeError('Failed to fetch'));

    // Act
    const first = await loadRouteGeometry('TEST_offline_inbound');
    const retryMock = stubFetch(okBody);
    const second = await loadRouteGeometry('TEST_offline_inbound');

    // Assert
    expect(first).toBeNull();
    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(2);
  });

  test('retries after a 5xx — the file may well exist', async () => {
    // Arrange
    stubFetch(null, 503);

    // Act
    const first = await loadRouteGeometry('TEST_5xx_inbound');
    const retryMock = stubFetch(okBody);
    const second = await loadRouteGeometry('TEST_5xx_inbound');

    // Assert
    expect(first).toBeNull();
    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(2);
  });

  test('negative-caches a malformed polyline rather than emitting NaN', async () => {
    // Arrange
    const fetchMock = stubFetch({ poly: [[-0.1, 51.5], ['nope', 51.51]] });

    // Act
    const first = await loadRouteGeometry('TEST_badvertex_inbound');
    const second = await loadRouteGeometry('TEST_badvertex_inbound');

    // Assert — a corrupt payload is as definitive as a 404
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('negative-caches a too-short polyline', async () => {
    // Arrange — one vertex is not a line
    const fetchMock = stubFetch({ poly: [[-0.1, 51.5]] });

    // Act
    await loadRouteGeometry('TEST_short_inbound');
    const second = await loadRouteGeometry('TEST_short_inbound');

    // Assert
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
