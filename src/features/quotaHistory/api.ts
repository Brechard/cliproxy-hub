/**
 * Client for the reset-router history service (router/README.md). It is not the
 * Management API, so it bypasses apiClient; the management key is only sent as a
 * bearer token and never stored, logged or surfaced in errors.
 */

import type {
  HistoryAccount,
  HistoryProvider,
  LatestLimit,
  QuotaHistory,
  SeriesPoint,
} from './types';

export const HISTORY_SERVICE_PORT = 8318;
export const HISTORY_PATH = '/v1/quota-history';
/** Sent by the router on every response, so its 401 is told apart from another server's. */
export const HISTORY_SERVICE_HEADER = 'X-Quota-History';

export type QuotaHistoryErrorKind = 'unauthorized' | 'unavailable';

export class QuotaHistoryError extends Error {
  readonly kind: QuotaHistoryErrorKind;

  constructor(kind: QuotaHistoryErrorKind, message: string) {
    super(message);
    this.name = 'QuotaHistoryError';
    this.kind = kind;
  }
}

/** Accept `host:port` or a full URL; always return an origin-style base without a trailing slash. */
export function normalizeServiceUrl(input: string): string {
  let base = (input || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  return base;
}

/** The service runs on the proxy's host, on its own port, over the panel's protocol. */
export function defaultServiceUrl(
  apiBase: string,
  location: Pick<Location, 'protocol' | 'hostname'>
): string {
  let hostname = location.hostname;
  try {
    if (apiBase) hostname = new URL(normalizeServiceUrl(apiBase)).hostname || hostname;
  } catch {
    // keep the panel's own hostname
  }
  return `${location.protocol}//${hostname}:${HISTORY_SERVICE_PORT}`;
}

/**
 * Where to look for history, in order: the proxy's own origin (a reverse proxy such as
 * Tailscale Serve or Funnel can route /v1/quota-history to the router there), then the
 * proxy's host on port 8318, which is how a bare local install serves it.
 */
export function serviceUrlCandidates(
  apiBase: string,
  location: Pick<Location, 'protocol' | 'hostname' | 'origin'>
): string[] {
  let origin = location.origin;
  try {
    if (apiBase) origin = new URL(normalizeServiceUrl(apiBase)).origin;
  } catch {
    // keep the panel's own origin
  }
  const candidates = [origin, defaultServiceUrl(apiBase, location)]
    .map(normalizeServiceUrl)
    .filter((url) => url && url !== 'null');
  return [...new Set(candidates)];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parseProvider = (value: unknown): HistoryProvider | null =>
  value === undefined || value === null || value === 'claude'
    ? 'claude'
    : value === 'codex'
      ? 'codex'
      : null;

const parsePoint = (raw: unknown): SeriesPoint | null => {
  if (!Array.isArray(raw) || !finite(raw[0]) || !finite(raw[1])) return null;
  return [raw[0], raw[1], finite(raw[2]) ? raw[2] : null];
};

const parseLatest = (raw: unknown): LatestLimit | null => {
  if (!isRecord(raw) || typeof raw.label !== 'string' || !finite(raw.percent)) return null;
  return { label: raw.label, percent: raw.percent, reset: finite(raw.reset) ? raw.reset : null };
};

/** Validate untrusted JSON; drops malformed rows and sorts every series by time. */
export function parseQuotaHistory(raw: unknown): QuotaHistory {
  if (!isRecord(raw) || !finite(raw.now) || !Array.isArray(raw.accounts)) {
    throw new QuotaHistoryError('unavailable', 'Unexpected quota history response');
  }
  const accounts: HistoryAccount[] = [];
  for (const entry of raw.accounts) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue;
    // Skip providers this panel cannot chart rather than mixing them into Claude.
    const provider = parseProvider(entry.provider);
    if (!provider) continue;
    const series: Record<string, SeriesPoint[]> = {};
    if (isRecord(entry.series)) {
      for (const [label, points] of Object.entries(entry.series)) {
        if (!Array.isArray(points)) continue;
        const parsed = points
          .map(parsePoint)
          .filter((p): p is SeriesPoint => p !== null)
          .sort((a, b) => a[0] - b[0]);
        if (parsed.length) series[label] = parsed;
      }
    }
    accounts.push({
      name: entry.name,
      provider,
      priority: finite(entry.priority) ? entry.priority : null,
      sampled: finite(entry.sampled) ? entry.sampled : null,
      latest: Array.isArray(entry.latest)
        ? entry.latest.map(parseLatest).filter((l): l is LatestLimit => l !== null)
        : [],
      series,
    });
  }
  return { now: raw.now, accounts };
}

export interface FetchQuotaHistoryOptions {
  baseUrl: string;
  managementKey: string;
  days: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Failure from one address, plus whether that address is certainly the history service. */
class AttemptError extends QuotaHistoryError {
  readonly fromService: boolean;

  constructor(kind: QuotaHistoryErrorKind, message: string, fromService: boolean) {
    super(kind, message);
    this.fromService = fromService;
  }
}

export async function fetchQuotaHistory({
  baseUrl,
  managementKey,
  days,
  signal,
  fetchImpl = fetch,
}: FetchQuotaHistoryOptions): Promise<QuotaHistory> {
  const base = normalizeServiceUrl(baseUrl);
  if (!base) throw new QuotaHistoryError('unavailable', 'No history service URL');
  let response: Response;
  try {
    response = await fetchImpl(`${base}${HISTORY_PATH}?days=${encodeURIComponent(String(days))}`, {
      headers: { Authorization: `Bearer ${managementKey}` },
      cache: 'no-store',
      credentials: 'omit',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AttemptError('unavailable', 'History service unreachable', false);
  }
  const fromService = response.headers.get(HISTORY_SERVICE_HEADER) === '1';
  if (response.status === 401 || response.status === 403) {
    throw new AttemptError(
      'unauthorized',
      'History service rejected the management key',
      fromService
    );
  }
  if (!response.ok) {
    throw new AttemptError(
      'unavailable',
      `History service returned ${response.status}`,
      fromService
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AttemptError('unavailable', 'Unexpected quota history response', fromService);
  }
  return parseQuotaHistory(body);
}

export interface FetchFromCandidatesOptions extends Omit<FetchQuotaHistoryOptions, 'baseUrl'> {
  baseUrls: readonly string[];
}

/** Remembers which candidate answered, per candidate list, so later loads ask it first. */
const preferred = new Map<string, string>();

export const clearPreferredServiceUrls = () => preferred.clear();

/**
 * Try each address in order and return the first history response. A 401 that is certainly
 * from the router stops the search; otherwise a 401 only counts if no address answers.
 */
export async function fetchQuotaHistoryFrom({
  baseUrls,
  ...options
}: FetchFromCandidatesOptions): Promise<{ history: QuotaHistory; baseUrl: string }> {
  const list = [...new Set(baseUrls.map(normalizeServiceUrl).filter(Boolean))];
  if (!list.length) throw new QuotaHistoryError('unavailable', 'No history service URL');
  const key = list.join('|');
  const first = preferred.get(key);
  const ordered =
    first && list.includes(first) ? [first, ...list.filter((u) => u !== first)] : list;
  let rejected = false;
  for (const [index, baseUrl] of ordered.entries()) {
    try {
      const history = await fetchQuotaHistory({ ...options, baseUrl });
      preferred.set(key, baseUrl);
      return { history, baseUrl };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!(error instanceof QuotaHistoryError) || error.kind !== 'unauthorized') continue;
      const fromService = error instanceof AttemptError && error.fromService;
      // A 401 the router signed is a real rejection of the key. An unsigned one (an older
      // router, or another server at the same path) only counts from the last address.
      if (fromService) throw new QuotaHistoryError('unauthorized', error.message);
      if (index === ordered.length - 1) rejected = true;
    }
  }
  if (rejected) {
    throw new QuotaHistoryError('unauthorized', 'History service rejected the management key');
  }
  throw new QuotaHistoryError('unavailable', 'History service unreachable');
}
