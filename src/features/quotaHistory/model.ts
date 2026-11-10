/**
 * Pure quota-history math: remaining-quota lines, pooled sums across resets,
 * burn rate and the soonest-reset-first projection that mirrors the reset router.
 * Times are epoch seconds, percents are 0-100 per account.
 */

import type {
  AccountState,
  BurnRate,
  Gain,
  HistoryAccount,
  Line,
  Projection,
  RemainingPoint,
  SeriesPoint,
} from './types';

export const HOUR = 3600;
export const DAY = 86400;
export const WEEK = 7 * DAY;

/** Only weekly windows have a known period, so only they are projected. */
export const periodFor = (label: string): number | null =>
  label.startsWith('Weekly') ? WEEK : null;

/** Weekly first, then 5-hour, then model-scoped limits alphabetically. */
export const limitLabels = (accounts: readonly HistoryAccount[]): string[] => {
  const seen = new Set<string>();
  for (const account of accounts) {
    for (const label of Object.keys(account.series)) seen.add(label);
  }
  const order = (label: string) => (label === 'Weekly' ? 0 : label === '5-hour' ? 1 : 2);
  const labels = [...seen].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return labels.length ? labels : ['Weekly'];
};

export const seriesFor = (accounts: readonly HistoryAccount[], label: string): SeriesPoint[][] =>
  accounts.map((account) => account.series[label] ?? []).filter((series) => series.length > 0);

/**
 * Remaining percent over time. A reset that happened between two readings is
 * drawn as a vertical step at the reset instant, tagged with how much it gave back.
 */
export function remainingPoints(series: readonly SeriesPoint[]): RemainingPoint[] {
  const pts: RemainingPoint[] = [];
  series.forEach(([t, used], i) => {
    if (i > 0) {
      const [prevT, prevUsed, prevReset] = series[i - 1];
      if (prevReset && prevReset > prevT && prevReset <= t) {
        pts.push({ t: prevReset, v: 100 - prevUsed });
        pts.push({ t: prevReset, v: 100, gain: prevUsed });
      }
    }
    pts.push({ t, v: 100 - used });
  });
  return pts;
}

/** Linear interpolation; null before the first point, flat after the last. */
export function interp(pts: readonly RemainingPoint[], t: number): number | null {
  if (!pts.length || t < pts[0].t) return null;
  const last = pts[pts.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

function sumAt(lines: readonly Line[], t: number): number | null {
  let total = 0;
  for (const line of lines) {
    const v = interp(line.pts, t);
    if (v == null) return null;
    total += v;
  }
  return total;
}

/**
 * Pool = sum of every account's remaining percent, from the instant all accounts
 * have data. When accounts reset at the same instant their gains are summed into one step.
 */
export function poolLine(lines: readonly Line[]): { pts: RemainingPoint[]; gains: Gain[] } {
  if (!lines.length || lines.some((line) => !line.pts.length)) return { pts: [], gains: [] };
  const start = Math.max(...lines.map((line) => line.pts[0].t));
  const times = [...new Set(lines.flatMap((line) => line.pts.map((p) => p.t)))]
    .filter((t) => t >= start)
    .sort((a, b) => a - b);
  const pts: RemainingPoint[] = [];
  const gains: Gain[] = [];
  for (const t of times) {
    const resets = lines.filter((line) => line.pts.some((p) => p.t === t && p.gain != null));
    if (resets.length) {
      let before = 0;
      for (const line of lines) {
        before += resets.includes(line)
          ? (line.pts.find((p) => p.t === t)?.v ?? 0)
          : (interp(line.pts, t) ?? 0);
      }
      const gain = resets.reduce(
        (sum, line) => sum + (line.pts.find((p) => p.t === t && p.gain != null)?.gain ?? 0),
        0
      );
      pts.push({ t, v: before }, { t, v: before + gain });
      gains.push({ t, v: before + gain, gain });
    } else {
      const v = sumAt(lines, t);
      if (v != null) pts.push({ t, v });
    }
  }
  return { pts, gains };
}

/**
 * Percent consumed in (from, to]. Intervals that cross a reset are skipped:
 * the used percent drops there, and a rolled window moves its reset time.
 */
export function drained(series: readonly SeriesPoint[], from: number, to: number): number {
  let total = 0;
  for (let i = 1; i < series.length; i++) {
    const [, usedA, resetA] = series[i - 1];
    const [tB, usedB, resetB] = series[i];
    if (tB <= from || tB > to) continue;
    if (resetA && resetA <= tB) continue;
    if (resetA && resetB && Math.abs(resetA - resetB) > HOUR) continue;
    total += Math.max(0, usedB - usedA);
  }
  return total;
}

/**
 * Pool-wide burn in %/h over the last `hours`. When history is too short, a weekly
 * limit falls back to its average since the window opened.
 */
export function burnRate(
  accounts: readonly HistoryAccount[],
  label: string,
  hours: number,
  now: number
): BurnRate {
  const all = seriesFor(accounts, label);
  if (!all.length) return { rate: 0, source: 'none', hours };
  const from = now - hours * HOUR;
  const first = Math.min(...all.map((series) => series[0][0]));
  const covered = now - Math.max(from, first);
  if (covered >= Math.max(1800, hours * HOUR * 0.5)) {
    const total = all.reduce((sum, series) => sum + drained(series, from, now), 0);
    return { rate: total / (covered / HOUR), source: 'window', hours };
  }
  const period = periodFor(label);
  if (period) {
    let rate = 0;
    for (const series of all) {
      const [, used, reset] = series[series.length - 1];
      if (!reset) continue;
      const elapsed = now - (reset - period);
      if (elapsed > HOUR && reset > now) rate += used / (elapsed / HOUR);
    }
    return { rate, source: 'weekAverage', hours };
  }
  return { rate: 0, source: 'collecting', hours };
}

/** Rolling burn-rate series for the drain-rate view, sampled ~300 times across the range. */
export function rateSeries(
  accounts: readonly HistoryAccount[],
  label: string,
  hours: number,
  start: number,
  now: number
): RemainingPoint[] {
  const all = seriesFor(accounts, label);
  if (!all.length) return [];
  const first = Math.min(...all.map((series) => series[0][0]));
  const step = Math.max(300, Math.round((now - start) / 300));
  const pts: RemainingPoint[] = [];
  for (let t = Math.max(start, first + 1800); t <= now; t += step) {
    const from = Math.max(t - hours * HOUR, first);
    const total = all.reduce((sum, series) => sum + drained(series, from, t), 0);
    pts.push({ t, v: total / ((t - from) / HOUR) });
  }
  return pts;
}

/**
 * Each account's remaining percent at `now`. An elapsed weekly window counts as
 * refilled (the router has not read it yet) and its reset rolls forward.
 */
export function latestState(
  accounts: readonly HistoryAccount[],
  label: string,
  now: number,
  colorFor: (index: number) => string
): AccountState[] {
  const period = periodFor(label);
  const states: AccountState[] = [];
  accounts.forEach((account, index) => {
    const series = account.series[label];
    if (!series?.length) return;
    const [, used, resetAt] = series[series.length - 1];
    let reset = resetAt;
    let rem = 100 - used;
    if (reset && period) {
      while (reset <= now) {
        reset += period;
        rem = 100;
      }
    }
    states.push({ name: account.name, color: colorFor(index), rem, reset });
  });
  return states;
}

/**
 * Drain `rate` %/h from the account whose weekly window resets soonest, refilling
 * each account to 100% at its reset. Steps every 15 minutes.
 */
export function project(
  states: readonly AccountState[],
  period: number | null,
  rate: number,
  now: number,
  end: number
): Projection {
  const accs = states.map((state) => ({ ...state, pts: [{ t: now, v: state.rem }] }));
  const total = () => accs.reduce((sum, acc) => sum + acc.rem, 0);
  const pool: RemainingPoint[] = [{ t: now, v: total() }];
  const gains: Gain[] = [];
  const emptyNow = accs.find((acc) => acc.rem <= 0);
  let firstEmpty: Projection['firstEmpty'] = emptyNow ? { t: now, name: emptyNow.name } : null;
  let poolEmpty: number | null = total() <= 0 ? now : null;
  const step = 900;
  for (let t = now + step; t <= end; t += step) {
    const resetting = accs
      .filter((acc) => acc.reset && acc.reset <= t)
      .sort((a, b) => (a.reset ?? 0) - (b.reset ?? 0));
    for (const acc of resetting) {
      const resetAt = acc.reset ?? t;
      const before = total();
      const gain = 100 - acc.rem;
      acc.pts.push({ t: resetAt, v: acc.rem }, { t: resetAt, v: 100 });
      pool.push({ t: resetAt, v: before }, { t: resetAt, v: before + gain });
      if (gain >= 1) gains.push({ t: resetAt, v: before + gain, gain, name: acc.name });
      acc.rem = 100;
      acc.reset = period ? resetAt + period : null;
    }
    let need = (rate * step) / HOUR;
    const draining = accs
      .filter((acc) => acc.rem > 0)
      .sort((a, b) => (a.reset ?? Infinity) - (b.reset ?? Infinity));
    for (const acc of draining) {
      if (need <= 0) break;
      const take = Math.min(acc.rem, need);
      acc.rem -= take;
      need -= take;
      if (acc.rem <= 1e-6) {
        acc.rem = 0;
        if (!firstEmpty) firstEmpty = { t, name: acc.name };
      }
    }
    for (const acc of accs) acc.pts.push({ t, v: acc.rem });
    const sum = total();
    pool.push({ t, v: sum });
    if (sum <= 1e-6 && poolEmpty == null) poolEmpty = t;
  }
  return { accs, pool, gains, firstEmpty, poolEmpty };
}

/** Round a chart maximum up to 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
