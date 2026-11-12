import { useCallback, useMemo, useState } from 'react';
import { useAuthStore } from '@/stores';
import { normalizeServiceUrl, serviceUrlCandidates } from './api';
import { sanitizeSettings } from './chartModel';
import { QuotaHistoryCard, type HistoryServiceControls } from './QuotaHistoryCard';
import { readServiceUrlOverride, readStoredSettings, writeServiceUrlOverride } from './storage';
import type { HistoryProvider } from './types';
import { useQuotaHistory } from './useQuotaHistory';

interface Props {
  /** Providers whose card the current tab shows, in order. Empty hides the section and stops fetching. */
  providers: readonly HistoryProvider[];
  /** The Quota page's own reload state, so a header refresh also refreshes the chart. */
  refreshing: boolean;
}

/**
 * One history request feeds a card per provider. With several providers (the All tab), a
 * provider with no recorded accounts is left out, so an older router shows only Claude.
 */
export function QuotaHistorySection({ providers, refreshing }: Props) {
  const apiBase = useAuthStore((state) => state.apiBase);
  const active = providers.length > 0;

  const [override, setOverride] = useState(readServiceUrlOverride);
  const candidates = useMemo(() => serviceUrlCandidates(apiBase, window.location), [apiBase]);
  const serviceUrls = useMemo(() => (override ? [override] : candidates), [override, candidates]);

  const [daysByProvider, setDaysByProvider] = useState<Record<HistoryProvider, number>>(() => ({
    claude: sanitizeSettings(readStoredSettings('claude'), []).historyDays,
    codex: sanitizeSettings(readStoredSettings('codex'), []).historyDays,
  }));
  const days = Math.max(...providers.map((provider) => daysByProvider[provider]), 1);
  const onDaysChange = useCallback(
    (provider: HistoryProvider, value: number) =>
      setDaysByProvider((prev) => ({ ...prev, [provider]: value })),
    []
  );

  const { data, error, loading, reload } = useQuotaHistory({
    active,
    days,
    serviceUrls,
    refreshing,
  });

  const service = useMemo<HistoryServiceControls>(
    () => ({
      override,
      automatic: candidates.join(' → '),
      save: (url) => {
        writeServiceUrlOverride(url);
        setOverride(normalizeServiceUrl(url));
      },
      reset: () => {
        writeServiceUrlOverride('');
        setOverride('');
      },
    }),
    [override, candidates]
  );

  if (!active) return null;
  const shown = providers.filter(
    (provider, index) =>
      providers.length === 1 ||
      index === 0 ||
      Boolean(data?.accounts.some((account) => account.provider === provider))
  );
  return (
    <>
      {shown.map((provider) => (
        <QuotaHistoryCard
          key={provider}
          provider={provider}
          data={data}
          error={error}
          loading={loading}
          reload={reload}
          service={service}
          onDaysChange={onDaysChange}
        />
      ))}
    </>
  );
}
