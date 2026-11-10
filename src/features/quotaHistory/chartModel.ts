import {
  DAY,
  HOUR,
  WEEK,
  burnRate,
  latestState,
  limitLabels,
  niceMax,
  periodFor,
  poolLine,
  project,
  rateSeries,
  remainingPoints,
} from './model';
import { accountColor } from './palette';
import type {
  AccountState,
  BurnRate,
  HistoryAccount,
  Line,
  Projection,
  RemainingPoint,
} from './types';

export const METRICS = ['remaining', 'drain'] as const;
export const VIEWS = ['pool', 'accounts'] as const;
export const BURN_HOURS = [1, 3, 6, 24] as const;
export const FUTURE_FACTORS = ['1', '0.5', '2', '0'] as const;
export const HISTORY_DAYS = [1, 3, 7, 30] as const;

export type Metric = (typeof METRICS)[number];
export type View = (typeof VIEWS)[number];
export type FutureFactor = (typeof FUTURE_FACTORS)[number];

export interface ChartSettings {
  limit: string;
  metric: Metric;
  view: View;
  burnHours: number;
  future: FutureFactor;
  historyDays: number;
}

export const DEFAULT_SETTINGS: ChartSettings = {
  limit: 'Weekly',
  metric: 'remaining',
  view: 'pool',
  burnHours: 3,
  future: '1',
  historyDays: 3,
};

export type SeriesRole = 'recorded' | 'projected' | 'drain' | 'account';

export interface ChartSeries {
  role: SeriesRole;
  /** Account name for role 'account' and for projected account lines. */
  name: string | null;
  color: string;
  pts: RemainingPoint[];
  area?: boolean;
  dashed?: boolean;
  hideLegend?: boolean;
}

export interface ChartAnnotation {
  t: number;
  v: number;
  kind: 'gain' | 'empty';
  gain?: number;
  color?: string;
}

export interface ChartModel {
  label: string;
  period: number | null;
  accountCount: number;
  now: number;
  x0: number;
  x1: number;
  yMax: number;
  unit: '%' | '%/h';
  series: ChartSeries[];
  annotations: ChartAnnotation[];
  states: AccountState[];
  current: number;
  burn: BurnRate;
  projection: Projection | null;
}

export const POOL_COLOR = 'var(--qh-accent)';

export interface BuildInput {
  accounts: readonly HistoryAccount[];
  now: number;
  settings: ChartSettings;
}

export function buildChartModel({ accounts, now, settings }: BuildInput): ChartModel {
  const { limit: label, burnHours, historyDays } = settings;
  const factor = Number(settings.future);
  const period = periodFor(label);
  const lines: Line[] = [];
  accounts.forEach((account, index) => {
    const series = account.series[label];
    if (series?.length) {
      lines.push({
        name: account.name,
        color: accountColor(index),
        pts: remainingPoints(series),
      });
    }
  });
  const n = lines.length;
  const x0 = now - historyDays * DAY;
  // Without a period there is no projection, so the 5-hour view only needs a sliver of future.
  const x1 = period ? now + WEEK : now + HOUR;
  const burn = burnRate(accounts, label, burnHours, now);
  const states = latestState(accounts, label, now, accountColor);
  const projection = period ? project(states, period, burn.rate * factor, now, x1) : null;
  const pool = poolLine(lines);
  const series: ChartSeries[] = [];
  const annotations: ChartAnnotation[] = [];
  let yMax: number;
  let unit: ChartModel['unit'] = '%';

  if (settings.metric === 'drain') {
    const pts = rateSeries(accounts, label, burnHours, x0, now);
    const projected = burn.rate * factor;
    yMax = niceMax(Math.max(1, projected, ...pts.map((p) => p.v)) * 1.15);
    unit = '%/h';
    series.push({ role: 'drain', name: null, color: POOL_COLOR, pts, area: true });
    if (projection) {
      series.push({
        role: 'projected',
        name: null,
        color: POOL_COLOR,
        pts: [
          { t: now, v: projected },
          { t: x1, v: projected },
        ],
        dashed: true,
      });
    }
  } else if (settings.view === 'pool') {
    yMax = Math.max(100, n * 100);
    series.push({ role: 'recorded', name: null, color: POOL_COLOR, pts: pool.pts, area: true });
    if (projection) {
      series.push({
        role: 'projected',
        name: null,
        color: POOL_COLOR,
        pts: projection.pool,
        dashed: true,
        area: true,
      });
    }
    const gains = pool.gains.concat(projection ? projection.gains : []);
    for (const g of gains) {
      if (g.gain >= 1) annotations.push({ t: g.t, v: g.v, kind: 'gain', gain: g.gain });
    }
    if (projection?.poolEmpty) {
      annotations.push({ t: projection.poolEmpty, v: 0, kind: 'empty' });
    }
  } else {
    yMax = 100;
    for (const line of lines) {
      series.push({ role: 'account', name: line.name, color: line.color, pts: line.pts });
    }
    if (projection) {
      for (const acc of projection.accs) {
        series.push({
          role: 'projected',
          name: acc.name,
          color: acc.color,
          pts: acc.pts,
          dashed: true,
          hideLegend: true,
        });
        for (let i = 1; i < acc.pts.length; i++) {
          const p = acc.pts[i - 1];
          const q = acc.pts[i];
          if (p.t === q.t && q.v - p.v >= 1) {
            annotations.push({ t: q.t, v: q.v, kind: 'gain', gain: q.v - p.v, color: acc.color });
          }
        }
      }
    }
  }
  return {
    label,
    period,
    accountCount: n,
    now,
    x0,
    x1,
    yMax,
    unit,
    series,
    annotations,
    states,
    current: states.reduce((sum, s) => sum + s.rem, 0),
    burn,
    projection,
  };
}

/** Keep stored settings valid for the labels the service actually reports. */
export function sanitizeSettings(raw: unknown, accounts: readonly HistoryAccount[]): ChartSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const labels = limitLabels(accounts);
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  return {
    limit: pick(
      source.limit,
      labels,
      labels.includes(DEFAULT_SETTINGS.limit) ? 'Weekly' : labels[0]
    ),
    metric: pick(source.metric, METRICS, DEFAULT_SETTINGS.metric),
    view: pick(source.view, VIEWS, DEFAULT_SETTINGS.view),
    burnHours: pick(source.burnHours, BURN_HOURS, DEFAULT_SETTINGS.burnHours),
    future: pick(source.future, FUTURE_FACTORS, DEFAULT_SETTINGS.future),
    historyDays: pick(source.historyDays, HISTORY_DAYS, DEFAULT_SETTINGS.historyDays),
  };
}

export interface Tick {
  t: number;
  /** Midnight ticks show the weekday and day; others show the time. */
  day: boolean;
}

/** Local-time axis ticks: 3h/6h steps up to 2.5 days, then daily (every third day past 20). */
export function xTicks(x0: number, x1: number): Tick[] {
  const span = x1 - x0;
  const ticks: Tick[] = [];
  if (span <= 2.5 * DAY) {
    const stepHours = span <= DAY ? 3 : 6;
    const start = new Date(x0 * 1000);
    start.setMinutes(0, 0, 0);
    for (let t = start.getTime() / 1000; t <= x1; t += HOUR) {
      const hour = new Date(t * 1000).getHours();
      if (t >= x0 && hour % stepHours === 0) ticks.push({ t, day: hour === 0 });
    }
  } else {
    const every = span > 20 * DAY ? 3 : 1;
    const start = new Date(x0 * 1000);
    start.setHours(0, 0, 0, 0);
    for (let i = 0; ; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const t = day.getTime() / 1000;
      if (t > x1) break;
      if (t >= x0 && i % every === 0) ticks.push({ t, day: true });
    }
  }
  return ticks;
}
