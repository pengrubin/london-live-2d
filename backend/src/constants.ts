/** How long a cached arrivals response stays "fresh" (served as x-cache: hit). */
export const ARRIVALS_CACHE_TTL_MS = 8_000;

/** Abort upstream TfL fetches that take longer than this. */
export const UPSTREAM_TIMEOUT_MS = 8_000;

/** Max outbound TfL calls per sliding window (the P2 train-tracking lane). */
export const TFL_BUDGET_LIMIT = 60;

/** Sliding-window length for the outbound budget. */
export const TFL_BUDGET_WINDOW_MS = 60_000;

/** Bounds on the `lines` query parameter. */
export const MIN_LINE_IDS = 1;
export const MAX_LINE_IDS = 30;

/** TfL line ids are lowercase slugs, e.g. "victoria", "elizabeth-line". */
export const LINE_ID_PATTERN = /^[a-z0-9-]+$/;

export const TFL_BASE_URL = 'https://api.tfl.gov.uk';

export const DEFAULT_PORT = 3000;
export const DEFAULT_CORS_ORIGIN = 'http://localhost:5173';
