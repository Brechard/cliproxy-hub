/** Browser-persisted preferences for the quota history card. Every access tolerates blocked storage. */

import { normalizeServiceUrl } from './api';
import type { ChartSettings } from './chartModel';

const SERVICE_URL_KEY = 'quotaHistory.serviceUrl';
const SETTINGS_KEY = 'quotaHistory.settings';

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

export const readStoredSettings = (): unknown => {
  const raw = read(SETTINGS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

export const writeStoredSettings = (settings: ChartSettings) =>
  write(SETTINGS_KEY, JSON.stringify(settings));
