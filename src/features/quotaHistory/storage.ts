/** Browser-persisted preferences for the quota history card. Every access tolerates blocked storage. */

import { normalizeServiceUrl } from './api';
import type { ChartSettings } from './chartModel';
import type { HistoryProvider } from './types';

const SERVICE_URL_KEY = 'quotaHistory.serviceUrl';
/** Claude keeps the original key so existing chart settings carry over. */
const settingsKey = (provider: HistoryProvider) =>
  provider === 'claude' ? 'quotaHistory.settings' : `quotaHistory.settings.${provider}`;

const read = (key: string): string | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null) => {
  try {
    if (typeof window === 'undefined') return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
};

export const readServiceUrlOverride = (): string =>
  normalizeServiceUrl(read(SERVICE_URL_KEY) ?? '');

export const writeServiceUrlOverride = (url: string) => {
  const normalized = normalizeServiceUrl(url);
  write(SERVICE_URL_KEY, normalized || null);
};

export const readStoredSettings = (provider: HistoryProvider): unknown => {
  const raw = read(settingsKey(provider));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

export const writeStoredSettings = (provider: HistoryProvider, settings: ChartSettings) =>
  write(settingsKey(provider), JSON.stringify(settings));
