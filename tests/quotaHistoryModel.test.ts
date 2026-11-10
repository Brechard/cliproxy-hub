import { describe, expect, test } from 'bun:test';
import { buildChartModel, DEFAULT_SETTINGS, sanitizeSettings } from '../src/features/quotaHistory/chartModel';
import {
  DAY,
  HOUR,
  WEEK,
  burnRate,
  drained,
  interp,
  latestState,
  limitLabels,
  poolLine,
  project,
  remainingPoints,
} from '../src/features/quotaHistory/model';
import type { AccountState, HistoryAccount, SeriesPoint } from '../src/features/quotaHistory/types';

const account = (name: string, series: Record<string, SeriesPoint[]>): HistoryAccount => ({
  name,
  priority: null,
  sampled: null,
  latest: [],
  series,
});

const color = () => '#000';

describe('remainingPoints', () => {
  test('draws a reset between two readings as a vertical step tagged with its gain', () => {
    const pts = remainingPoints([
      [1000, 60, 2000],
      [1900, 80, 2000],
      [2100, 5, 3000],
    ]);
    expect(pts).toEqual([
      { t: 1000, v: 40 },
      { t: 1900, v: 20 },
      { t: 2000, v: 20 },
      { t: 2000, v: 100, gain: 80 },
      { t: 2100, v: 95 },
    ]);
  });

  test('adds no step when the reset is still ahead', () => {
    const pts = remainingPoints([
      [0, 10, 500],
      [100, 20, 500],
    ]);
    expect(pts.some((p) => p.gain != null)).toBe(false);
  });
});

describe('interp', () => {
  test('is null before the first point, linear between, flat after the last', () => {
    const pts = [
      { t: 10, v: 100 },
      { t: 20, v: 0 },
    ];
    expect(interp(pts, 5)).toBeNull();
    expect(interp(pts, 15)).toBe(50);
    expect(interp(pts, 99)).toBe(0);
  });
});

describe('poolLine', () => {
  test('sums accounts and folds a reset into one pooled step', () => {
    const a = remainingPoints([
      [0, 50, 150],
      [100, 60, 150],
      [200, 10, 900],
    ]);
    const b = remainingPoints([
      [0, 20, 10_000],
      [100, 30, 10_000],
      [200, 40, 10_000],
    ]);
    const { pts, gains } = poolLine([
      { name: 'A', color: '', pts: a },
      { name: 'B', color: '', pts: b },
    ]);
    expect(pts).toEqual([
      { t: 0, v: 130 },
      { t: 100, v: 110 },
      { t: 150, v: 105 },
      { t: 150, v: 165 },
      { t: 200, v: 150 },
    ]);
    expect(gains).toEqual([{ t: 150, v: 165, gain: 60 }]);
  });

  test('starts only once every account has data', () => {
    const early = remainingPoints([
      [0, 0, null],
      [100, 0, null],
    ]);
    const late = remainingPoints([[50, 50, null]]);
    const { pts } = poolLine([
      { name: 'early', color: '', pts: early },
      { name: 'late', color: '', pts: late },
    ]);
    expect(pts[0].t).toBe(50);
  });
});

describe('drained and burnRate', () => {
  test('drained skips intervals that cross a reset or a rolled window', () => {
    const crossing: SeriesPoint[] = [
      [0, 10, 500],
      [100, 30, 500],
      [600, 5, 1500],
      [700, 15, 1500],
    ];
    expect(drained(crossing, 0, 700)).toBe(30);
    const rolled: SeriesPoint[] = [
      [0, 10, 10_000],
      [100, 40, 20_000],
    ];
    expect(drained(rolled, 0, 100)).toBe(0);
  });

  test('burn rate over the window ignores reset jumps', () => {
    const now = 1_000_000;
    const farReset = now + WEEK - 2.5 * HOUR;
    const accounts = [
      account('A', {
        Weekly: [
          [now - 4 * HOUR, 10, now - 2.5 * HOUR],
          [now - 3 * HOUR, 12, now - 2.5 * HOUR],
          [now - 2 * HOUR, 3, farReset],
          [now - HOUR, 5, farReset],
          [now, 8, farReset],
        ],
      }),
    ];
    const burn = burnRate(accounts, 'Weekly', 3, now);
    expect(burn.source).toBe('window');
    expect(burn.rate).toBeCloseTo(5 / 3, 6);
  });

  test('falls back to the week average while history is short', () => {
    const now = 1_000_000;
    const accounts = [account('A', { Weekly: [[now - 600, 20, now + WEEK / 2]] })];
    const burn = burnRate(accounts, 'Weekly', 3, now);
    expect(burn.source).toBe('weekAverage');
    expect(burn.rate).toBeCloseTo(20 / ((WEEK / 2) / HOUR), 6);
  });

  test('has no fallback for limits without a period', () => {
    const now = 1_000_000;
    const accounts = [account('A', { '5-hour': [[now - 600, 20, now + HOUR]] })];
    expect(burnRate(accounts, '5-hour', 3, now)).toMatchObject({ rate: 0, source: 'collecting' });
    expect(burnRate([], 'Weekly', 3, now).source).toBe('none');
  });
});

describe('latestState', () => {
  test('treats an elapsed weekly window as refilled and rolls its reset forward', () => {
    const now = 1_000_000;
    const accounts = [account('A', { Weekly: [[now - 300, 90, now - 100]] })];
    const [state] = latestState(accounts, 'Weekly', now, color);
    expect(state.rem).toBe(100);
    expect(state.reset).toBe(now - 100 + WEEK);
  });
});

describe('project', () => {
  const now = 2_000_000;
  const state = (name: string, rem: number, resetIn: number): AccountState => ({
    name,
    color: '',
    rem,
    reset: now + resetIn,
  });

  test('drains the soonest-reset account first and refills at its reset', () => {
    const result = project(
      [state('late', 80, 50 * HOUR), state('soon', 50, 10 * HOUR)],
      WEEK,
      10,
      now,
      now + 20 * HOUR
    );
    // 'soon' has 50% left at 10%/h, so it empties after 5h even though 'late' has more.
    expect(result.firstEmpty).toEqual({ t: now + 5 * HOUR, name: 'soon' });
    expect(result.gains).toHaveLength(1);
    expect(result.gains[0]).toMatchObject({ t: now + 10 * HOUR, gain: 100, name: 'soon' });
    const jump = result.pool.filter((p) => p.t === now + 10 * HOUR);
    expect(jump[1].v - jump[0].v).toBe(100);
    // 'late' absorbed the drain while 'soon' was empty: 80 - 19 steps of 2.5.
    expect(jump[0].v).toBeCloseTo(32.5, 6);
    expect(result.poolEmpty).toBeNull();
    const soon = result.accs.find((a) => a.name === 'soon');
    expect(soon?.reset).toBe(now + 10 * HOUR + WEEK);
  });

  test('reports when the whole pool runs dry', () => {
    const result = project([state('only', 10, 100 * HOUR)], WEEK, 10, now, now + 5 * HOUR);
    expect(result.poolEmpty).toBe(now + HOUR);
    expect(result.firstEmpty).toEqual({ t: now + HOUR, name: 'only' });
  });

  test('idle usage never drains', () => {
    const result = project([state('only', 40, 100 * HOUR)], WEEK, 0, now, now + 2 * DAY);
    expect(result.poolEmpty).toBeNull();
    expect(result.firstEmpty).toBeNull();
    expect(result.pool.every((p) => p.v === 40)).toBe(true);
  });
});

describe('buildChartModel', () => {
  const now = 3_000_000;
  const accounts = [
    account('A', {
      Weekly: [
        [now - 2 * HOUR, 20, now + DAY],
        [now, 25, now + DAY],
      ],
      '5-hour': [[now, 10, now + 2 * HOUR]],
    }),
    account('B', { Weekly: [[now, 50, now + 2 * DAY]] }),
  ];

  test('pools weekly remaining and projects it', () => {
    const model = buildChartModel({ accounts, now, settings: DEFAULT_SETTINGS });
    expect(model.accountCount).toBe(2);
    expect(model.yMax).toBe(200);
    expect(model.current).toBe(125);
    expect(model.series.map((s) => s.role)).toEqual(['recorded', 'projected']);
    expect(model.x1).toBe(now + WEEK);
  });

  test('shows the 5-hour limit as recorded only', () => {
    const model = buildChartModel({
      accounts,
      now,
      settings: { ...DEFAULT_SETTINGS, limit: '5-hour' },
    });
    expect(model.projection).toBeNull();
    expect(model.series.map((s) => s.role)).toEqual(['recorded']);
  });

  test('keeps stored settings only when valid for the reported limits', () => {
    expect(limitLabels(accounts)).toEqual(['Weekly', '5-hour']);
    const settings = sanitizeSettings({ limit: 'Weekly · Gone', burnHours: 6, view: 'nope' }, accounts);
    expect(settings.limit).toBe('Weekly');
    expect(settings.burnHours).toBe(6);
    expect(settings.view).toBe('pool');
  });
});
