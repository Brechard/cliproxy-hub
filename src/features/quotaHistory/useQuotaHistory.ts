import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore, useQuotaStore } from '@/stores';
import { QuotaHistoryError, fetchQuotaHistory, type QuotaHistoryErrorKind } from './api';
import type { QuotaHistory } from './types';

export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface Options {
  /** Fetch only while the card is shown. */
  active: boolean;
  days: number;
  serviceUrl: string;
  /** True while the Quota page reloads its own data; the falling edge refetches too. */
  refreshing: boolean;
}

export interface QuotaHistoryState {
  data: QuotaHistory | null;
  error: QuotaHistoryErrorKind | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads the router's history on mount, on the page's refresh, and every 5 minutes
 * while the tab is visible. Responses from a previous session, URL or range are dropped.
 */
export function useQuotaHistory({
  active,
  days,
  serviceUrl,
  refreshing,
}: Options): QuotaHistoryState {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const managementKey = useAuthStore((state) => state.managementKey);
  const generation = useQuotaStore((state) => state.cacheGeneration);
  const enabled = active && connected && Boolean(managementKey) && Boolean(serviceUrl);

  const scope = `${generation}|${serviceUrl}`;
  const [result, setResult] = useState<{
    scope: string;
    data: QuotaHistory | null;
    error: QuotaHistoryErrorKind | null;
  }>({ scope, data: null, error: null });
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);
  const lastLoadedRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled || inFlightRef.current) return;
    const requestId = ++requestRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const isCurrent = () =>
      requestId === requestRef.current && generation === useQuotaStore.getState().cacheGeneration;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const history = await fetchQuotaHistory({
        baseUrl: serviceUrl,
        managementKey,
        days,
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      lastLoadedRef.current = Date.now();
      setResult({ scope, data: history, error: null });
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const kind = err instanceof QuotaHistoryError ? err.kind : 'unavailable';
      setResult((prev) => ({
        scope,
        data: prev.scope === scope ? prev.data : null,
        error: kind,
      }));
    } finally {
      if (requestId === requestRef.current) {
        inFlightRef.current = false;
        setLoading(false);
      }
    }
  }, [days, enabled, generation, managementKey, scope, serviceUrl]);

  useEffect(() => {
    // A new session, range or URL supersedes whatever is in flight.
    abortRef.current?.abort();
    inFlightRef.current = false;
    void load();
    return () => {
      requestRef.current += 1;
      inFlightRef.current = false;
      abortRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!enabled) return;
    const refetchIfVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const onVisibility = () => {
      if (Date.now() - lastLoadedRef.current >= REFRESH_INTERVAL_MS) refetchIfVisible();
    };
    const timer = window.setInterval(refetchIfVisible, REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, load]);

  const wasRefreshingRef = useRef(refreshing);
  useEffect(() => {
    const was = wasRefreshingRef.current;
    wasRefreshingRef.current = refreshing;
    if (was && !refreshing) void load();
  }, [refreshing, load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  if (!enabled) return { data: null, error: null, loading: false, reload };
  const current = result.scope === scope ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? null, loading, reload };
}
