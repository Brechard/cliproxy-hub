/**
 * Client for the reset-router history service (router/README.md). It is not the
 * Management API, so it bypasses apiClient; the management key is only sent as a
 * bearer token and never stored, logged or surfaced in errors.
 */

import type { HistoryAccount, LatestLimit, QuotaHistory, SeriesPoint } from './types';

export const HISTORY_SERVICE_PORT = 8318;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

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
    response = await fetchImpl(
      `${base}/v1/quota-history?days=${encodeURIComponent(String(days))}`,
      {
        headers: { Authorization: `Bearer ${managementKey}` },
        cache: 'no-store',
        credentials: 'omit',
        signal,
      }
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new QuotaHistoryError('unavailable', 'History service unreachable');
  }
  if (response.status === 401 || response.status === 403) {
    throw new QuotaHistoryError('unauthorized', 'History service rejected the management key');
  }
  if (!response.ok) {
    throw new QuotaHistoryError('unavailable', `History service returned ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new QuotaHistoryError('unavailable', 'Unexpected quota history response');
  }
  return parseQuotaHistory(body);
}
