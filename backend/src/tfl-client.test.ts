import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUS_STATUS_TIMEOUT_MS,
  fetchBusLineStatus,
  fetchLineStatusWindow,
  fetchStopPointDisruptions,
  fetchStopPoints,
} from './tfl-client';
import { UPSTREAM_TIMEOUT_MS } from './constants';

const APP_KEY = 'test-key';

/** Records every URL the module hands to fetch and answers with one canned body. */
function stubFetch(status: number, body: unknown): URL[] {
  const urls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return urls;
}

describe('disruption fetchers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetchLineStatusWindow asks for explicit lines over a date window with detail', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const urls = stubFetch(200, [{ id: 'district', lineStatuses: [] }]);

    const response = await fetchLineStatusWindow(['district', 'tram'], '2026-09-02', '2026-09-10', APP_KEY);

    expect(response).toEqual({ status: 200, body: [{ id: 'district', lineStatuses: [] }] });
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe('/Line/district,tram/Status/2026-09-02/to/2026-09-10');
    expect(urls[0]?.searchParams.get('detail')).toBe('true');
    expect(urls[0]?.searchParams.get('app_key')).toBe(APP_KEY);
    expect(timeoutSpy).toHaveBeenCalledWith(UPSTREAM_TIMEOUT_MS);
  });

  it('fetchStopPointDisruptions targets the StopPoint disruption list for the given modes', async () => {
    const urls = stubFetch(200, []);

    const response = await fetchStopPointDisruptions(['tube', 'dlr'], APP_KEY);

    expect(response.status).toBe(200);
    expect(urls[0]?.pathname).toBe('/StopPoint/Mode/tube,dlr/Disruption');
    expect(urls[0]?.searchParams.get('detail')).toBeNull();
  });

  it('fetchStopPoints comma-joins the ids into one StopPoint lookup', async () => {
    // The bus-stop gazetteer's only network call; 20 ids per URL is the
    // measured ceiling, so the joined form has to survive verbatim.
    const urls = stubFetch(200, []);

    const response = await fetchStopPoints(['490006655CG', '490G00006655'], APP_KEY);

    expect(response.status).toBe(200);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe('/StopPoint/490006655CG,490G00006655');
    expect(urls[0]?.searchParams.get('app_key')).toBe(APP_KEY);
  });

  it('fetchBusLineStatus fetches every bus route status without detail and with the long timeout', async () => {
    // Measured 2026-09-02: 760 KB in 4.6 s — over half the 8 s default.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const urls = stubFetch(200, []);

    await fetchBusLineStatus(APP_KEY);

    expect(BUS_STATUS_TIMEOUT_MS).toBe(20_000);
    expect(urls[0]?.pathname).toBe('/Line/Mode/bus/Status');
    expect(urls[0]?.searchParams.get('detail')).toBeNull();
    expect(timeoutSpy).toHaveBeenCalledWith(BUS_STATUS_TIMEOUT_MS);
  });

  it('passes a non-200 status through unchanged for the caller to decide on', async () => {
    stubFetch(404, { httpStatusCode: 404, message: 'not found' });

    const response = await fetchLineStatusWindow([], '2026-09-02', '2026-09-10', APP_KEY);

    expect(response.status).toBe(404);
  });
});
