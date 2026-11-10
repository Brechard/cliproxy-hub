import type { TFunction } from 'i18next';
import type { ChartSeries } from './chartModel';
import { DAY, HOUR } from './model';

const KEY = 'quota_history.';

export const formatDay = (t: number, locale: string): string => {
  const d = new Date(t * 1000);
  return `${d.toLocaleDateString(locale, { weekday: 'short' })} ${d.getDate()}`;
};

export const formatTime = (t: number, locale: string): string =>
  new Date(t * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

export const formatMonthDay = (t: number, locale: string): string =>
  new Date(t * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric' });

/** "today 09:00 PM" for the current day, otherwise "Sat 01:00 AM". */
export const formatWhen = (
  t: number,
  now: number,
  locale: string,
  translate: TFunction
): string => {
  const sameDay = new Date(t * 1000).toDateString() === new Date(now * 1000).toDateString();
  return sameDay
    ? translate(`${KEY}when_today`, { time: formatTime(t, locale) })
    : `${new Date(t * 1000).toLocaleDateString(locale, { weekday: 'short' })} ${formatTime(t, locale)}`;
};

/** Short relative duration such as "3d 4h", "2h 10m" or "5m". */
export const formatDuration = (seconds: number, translate: TFunction): string => {
  if (seconds <= 0) return translate(`${KEY}duration_now`);
  const d = Math.floor(seconds / DAY);
  const h = Math.floor((seconds % DAY) / HOUR);
  const m = Math.floor((seconds % HOUR) / 60);
  if (d) return translate(`${KEY}duration_dh`, { d, h });
  if (h) return translate(`${KEY}duration_hm`, { h, m });
  return translate(`${KEY}duration_m`, { m });
};

/** Known labels are translated; model-scoped ones ("Weekly · Fable") keep their suffix. */
export const limitDisplayName = (label: string, translate: TFunction): string => {
  if (label === 'Weekly') return translate(`${KEY}limit_weekly`);
  if (label === '5-hour') return translate(`${KEY}limit_five_hour`);
  if (label.startsWith('Weekly · ')) {
    return `${translate(`${KEY}limit_weekly`)} · ${label.slice('Weekly · '.length)}`;
  }
  return label;
};

export const seriesDisplayName = (series: ChartSeries, translate: TFunction): string => {
  if (series.role === 'recorded') return translate(`${KEY}legend_recorded`);
  if (series.role === 'drain') return translate(`${KEY}legend_drain`);
  if (series.role === 'projected' && !series.name) return translate(`${KEY}legend_projected`);
  return series.name ?? '';
};
