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
import { accountColor, accountOpacity, limitColor } from './palette';
import type {
  AccountState,
  BurnRate,
  DrainOrder,
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
  /** Selected limit labels, never empty, in the order `limitLabels` reports them. */
  limits: string[];
  metric: Metric;
  view: View;
  burnHours: number;
  future: FutureFactor;
  historyDays: number;
}

export const DEFAULT_LIMITS = ['Weekly', 'Weekly · Fable'] as const;

export const DEFAULT_SETTINGS: ChartSettings = {
  limits: [...DEFAULT_LIMITS],
  metric: 'remaining',
  view: 'pool',
  burnHours: 3,
  future: '1',
  historyDays: 3,
};

export type SeriesRole = 'recorded' | 'projected' | 'drain' | 'account';

export interface ChartSeries {
  role: SeriesRole;
  /** Limit this line belongs to. */
  limit: string;
  /** Account name for role 'account' and for projected account lines. */
  name: string | null;
  color: string;
  pts: RemainingPoint[];
  area?: boolean;
  dashed?: boolean;
  hideLegend?: boolean;
  opacity?: number;
}

export interface ChartAnnotation {
  t: number;
  v: number;
  kind: 'gain' | 'empty';
  limit: string;
  gain?: number;
  color?: string;
}

export interface LimitModel {
  label: string;
  color: string;
  period: number | null;
  accountCount: number;
  states: AccountState[];
  current: number;
  burn: BurnRate;
  projection: Projection | null;
}

export interface ChartModel {
  limits: LimitModel[];
  /** Accounts with a reading in at least one selected limit. */
  accountCount: number;
  now: number;
  x0: number;
  x1: number;
  yMax: number;
  unit: '%' | '%/h';
  series: ChartSeries[];
  annotations: ChartAnnotation[];
}

export const POOL_COLOR = 'var(--qh-accent)';

export interface BuildInput {
  accounts: readonly HistoryAccount[];
  now: number;
  settings: ChartSettings;
  /** Defaults to the Claude router's soonest-reset rule. */
  drain?: DrainOrder;
}

export function buildChartModel({
  accounts,
  now,
  settings,
  drain = 'soonestReset',
}: BuildInput): ChartModel {
  const { limits: selected, burnHours, historyDays } = settings;
  const factor = Number(settings.future);
  const multi = selected.length > 1;
  const labels = limitLabels(accounts);
  const x0 = now - historyDays * DAY;
  // Without a period there is no projection, so a 5-hour-only view needs just a sliver of future.
  const x1 = selected.some((label) => periodFor(label)) ? now + WEEK : now + HOUR;

  const perLimit = selected.map((label) => {
    const period = periodFor(label);
    const color = limitColor(label, labels);
    const entries: Array<{ index: number; line: Line }> = [];
    accounts.forEach((account, index) => {
      const series = account.series[label];
      if (series?.length) {
        entries.push({
          index,
          line: { name: account.name, color: accountColor(index), pts: remainingPoints(series) },
        });
      }
    });
    const burn = burnRate(accounts, label, burnHours, now);
    const states = latestState(accounts, label, now, accountColor);
    const projection = period ? project(states, period, burn.rate * factor, now, x1, drain) : null;
    const lines = entries.map((entry) => entry.line);
    return { label, period, color, entries, lines, burn, states, projection };
  });

  const series: ChartSeries[] = [];
  const annotations: ChartAnnotation[] = [];
  let yMax: number;
  let unit: ChartModel['unit'] = '%';

  if (settings.metric === 'drain') {
    const drains = perLimit.map((l) => ({
      ...l,
      pts: rateSeries(accounts, l.label, burnHours, x0, now),
      projected: l.burn.rate * factor,
    }));
    yMax = niceMax(
      Math.max(1, ...drains.flatMap((l) => [l.projected, ...l.pts.map((p) => p.v)])) * 1.15
    );
    unit = '%/h';
    for (const l of drains) {
      series.push({
        role: 'drain',
        limit: l.label,
        name: null,
        color: multi ? l.color : POOL_COLOR,
        pts: l.pts,
        area: !multi,
      });
      if (l.projection) {
        series.push({
          role: 'projected',
          limit: l.label,
          name: null,
          color: multi ? l.color : POOL_COLOR,
          pts: [
            { t: now, v: l.projected },
            { t: x1, v: l.projected },
          ],
          dashed: true,
        });
      }
    }
  } else if (settings.view === 'pool') {
    yMax = Math.max(100, ...perLimit.map((l) => l.lines.length * 100));
    for (const l of perLimit) {
      const color = multi ? l.color : POOL_COLOR;
      const pool = poolLine(l.lines);
      series.push({
        role: 'recorded',
        limit: l.label,
        name: null,
        color,
        pts: pool.pts,
        area: !multi,
      });
      if (l.projection) {
        series.push({
          role: 'projected',
          limit: l.label,
          name: null,
          color,
          pts: l.projection.pool,
          dashed: true,
          area: !multi,
        });
      }
      const gains = pool.gains.concat(l.projection ? l.projection.gains : []);
      for (const g of gains) {
        if (g.gain >= 1) {
          annotations.push({
            t: g.t,
            v: g.v,
            kind: 'gain',
            limit: l.label,
            gain: g.gain,
            color: multi ? l.color : undefined,
          });
        }
      }
      if (l.projection?.poolEmpty) {
        annotations.push({
          t: l.projection.poolEmpty,
          v: 0,
          kind: 'empty',
          limit: l.label,
          color: multi ? l.color : undefined,
        });
      }
    }
  } else {
    yMax = 100;
    for (const l of perLimit) {
      // One limit keeps each account's own color; several limits take the limit's color
      // and fade by account position instead.
      const paint = (index: number, own: string) =>
        multi ? { color: l.color, opacity: accountOpacity(index) } : { color: own };
      for (const { index, line } of l.entries) {
        series.push({
          role: 'account',
          limit: l.label,
          name: line.name,
          pts: line.pts,
          ...paint(index, line.color),
        });
      }
      if (!l.projection) continue;
      for (const acc of l.projection.accs) {
        const index = accounts.findIndex((account) => account.name === acc.name);
        const style = paint(index, acc.color);
        series.push({
          role: 'projected',
          limit: l.label,
          name: acc.name,
          pts: acc.pts,
          dashed: true,
          hideLegend: true,
          ...style,
        });
        for (let i = 1; i < acc.pts.length; i++) {
          const p = acc.pts[i - 1];
          const q = acc.pts[i];
          if (p.t === q.t && q.v - p.v >= 1) {
            annotations.push({
              t: q.t,
              v: q.v,
              kind: 'gain',
              limit: l.label,
              gain: q.v - p.v,
              color: style.color,
            });
          }
        }
      }
    }
  }
  return {
    limits: perLimit.map((l) => ({
      label: l.label,
      color: l.color,
      period: l.period,
      accountCount: l.lines.length,
      states: l.states,
      current: l.states.reduce((sum, s) => sum + s.rem, 0),
      burn: l.burn,
      projection: l.projection,
    })),
    accountCount: accounts.filter((account) => selected.some((l) => account.series[l]?.length))
      .length,
    now,
    x0,
    x1,
    yMax,
    unit,
    series,
    annotations,
  };
}

/** Pick the default selection: Weekly and Weekly · Fable where reported, else the first label. */
export const defaultLimits = (labels: readonly string[]): string[] => {
  const picked = labels.filter((label) => (DEFAULT_LIMITS as readonly string[]).includes(label));
  return picked.length ? picked : labels.slice(0, 1);
};

/** Keep the stored selection that the service still reports; the old single `limit` counts as one. */
export const sanitizeLimits = (raw: unknown, labels: readonly string[]): string[] => {
  const wanted = Array.isArray(raw) ? raw : [raw];
  const picked = labels.filter((label) => wanted.includes(label));
  return picked.length ? picked : defaultLimits(labels);
};

/** Toggle one limit in the selection; the last selected limit cannot be removed. */
export const toggleLimit = (
  selected: readonly string[],
  label: string,
  labels: readonly string[]
): string[] => {
  if (!selected.includes(label)) return labels.filter((l) => l === label || selected.includes(l));
  return selected.length > 1 ? selected.filter((l) => l !== label) : [...selected];
};

/** Keep stored settings valid for the labels the service actually reports. */
export function sanitizeSettings(raw: unknown, accounts: readonly HistoryAccount[]): ChartSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const labels = limitLabels(accounts);
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  return {
    limits: sanitizeLimits(source.limits ?? source.limit, labels),
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
