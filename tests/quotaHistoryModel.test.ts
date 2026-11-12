import { describe, expect, test } from 'bun:test';
import {
  buildChartModel,
  DEFAULT_SETTINGS,
  sanitizeSettings,
  toggleLimit,
} from '../src/features/quotaHistory/chartModel';
import {
  GAIN_TRIES,
  placeLabels,
  textBox,
  textWidth,
} from '../src/features/quotaHistory/labelLayout';
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
  provider: 'claude',
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
    expect(burn.rate).toBeCloseTo(20 / (WEEK / 2 / HOUR), 6);
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

  test('priority drain empties the highest-priority account first, whatever its reset', () => {
    const states = [
      { ...state('jeanne', 60, 10 * HOUR), priority: 10 },
      { ...state('greg', 60, 50 * HOUR), priority: 20 },
    ];
    const byPriority = project(states, WEEK, 10, now, now + 8 * HOUR, 'priority');
    expect(byPriority.firstEmpty).toEqual({ t: now + 6 * HOUR, name: 'greg' });
    const bySoonest = project(states, WEEK, 10, now, now + 8 * HOUR);
    expect(bySoonest.firstEmpty).toEqual({ t: now + 6 * HOUR, name: 'jeanne' });
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
    const model = buildChartModel({
      accounts,
      now,
      settings: { ...DEFAULT_SETTINGS, limits: ['Weekly'] },
    });
    expect(model.accountCount).toBe(2);
    expect(model.yMax).toBe(200);
    expect(model.limits.map((l) => [l.label, l.current])).toEqual([['Weekly', 125]]);
    expect(model.series.map((s) => s.role)).toEqual(['recorded', 'projected']);
    expect(model.x1).toBe(now + WEEK);
  });

  test('shows the 5-hour limit as recorded only', () => {
    const model = buildChartModel({
      accounts,
      now,
      settings: { ...DEFAULT_SETTINGS, limits: ['5-hour'] },
    });
    expect(model.limits[0].projection).toBeNull();
    expect(model.series.map((s) => s.role)).toEqual(['recorded']);
  });

  test('keeps stored settings only when valid for the reported limits', () => {
    expect(limitLabels(accounts)).toEqual(['Weekly', '5-hour']);
    const settings = sanitizeSettings(
      { limits: ['Weekly · Gone'], burnHours: 6, view: 'nope' },
      accounts
    );
    expect(settings.limits).toEqual(['Weekly']);
    expect(settings.burnHours).toBe(6);
    expect(settings.view).toBe('pool');
  });
});

describe('several limits', () => {
  const now = 3_000_000;
  const both = [
    account('A', {
      Weekly: [
        [now - 2 * HOUR, 20, now + DAY],
        [now, 25, now + DAY],
      ],
      'Weekly · Fable': [
        [now - 2 * HOUR, 40, now + 2 * DAY],
        [now, 60, now + 2 * DAY],
      ],
      '5-hour': [[now, 10, now + 2 * HOUR]],
    }),
    account('B', {
      Weekly: [[now, 50, now + 2 * DAY]],
      'Weekly · Fable': [[now, 10, now + 3 * DAY]],
    }),
  ];
  const settings = { ...DEFAULT_SETTINGS, limits: ['Weekly', 'Weekly · Fable'] };

  test('defaults to Weekly and Weekly · Fable, falling back to the first label', () => {
    expect(sanitizeSettings(null, both).limits).toEqual(['Weekly', 'Weekly · Fable']);
    const onlyFive = [account('A', { '5-hour': [[1, 1, null]] })];
    expect(sanitizeSettings(null, onlyFive).limits).toEqual(['5-hour']);
    const noFable = [account('A', { '5-hour': [[1, 1, null]], Weekly: [[1, 1, null]] })];
    expect(sanitizeSettings(null, noFable).limits).toEqual(['Weekly']);
  });

  test('migrates the old single limit and drops unknown labels', () => {
    expect(sanitizeSettings({ limit: '5-hour' }, both).limits).toEqual(['5-hour']);
    expect(sanitizeSettings({ limit: 'Gone' }, both).limits).toEqual(['Weekly', 'Weekly · Fable']);
    expect(sanitizeSettings({ limits: ['Weekly · Fable', 'Gone', 'Weekly'] }, both).limits).toEqual(
      ['Weekly', 'Weekly · Fable']
    );
    expect(sanitizeSettings({ limits: [] }, both).limits).toEqual(['Weekly', 'Weekly · Fable']);
  });

  test('toggling keeps at least one limit and the reported order', () => {
    const labels = limitLabels(both);
    expect(toggleLimit(['Weekly'], 'Weekly', labels)).toEqual(['Weekly']);
    expect(toggleLimit(['Weekly'], 'Weekly · Fable', labels)).toEqual(['Weekly', 'Weekly · Fable']);
    expect(toggleLimit(['Weekly', 'Weekly · Fable'], 'Weekly', labels)).toEqual(['Weekly · Fable']);
    expect(toggleLimit(['Weekly', 'Weekly · Fable'], '5-hour', labels)).toEqual([
      'Weekly',
      '5-hour',
      'Weekly · Fable',
    ]);
  });

  test('pool view draws one recorded and projected line per limit, each with its own color', () => {
    const model = buildChartModel({ accounts: both, now, settings });
    expect(model.limits.map((l) => [l.label, l.current])).toEqual([
      ['Weekly', 125],
      ['Weekly · Fable', 130],
    ]);
    expect(model.series.map((s) => [s.limit, s.role])).toEqual([
      ['Weekly', 'recorded'],
      ['Weekly', 'projected'],
      ['Weekly · Fable', 'recorded'],
      ['Weekly · Fable', 'projected'],
    ]);
    const colors = model.series.map((s) => s.color);
    expect(colors[0]).toBe(colors[1]);
    expect(colors[2]).toBe(colors[3]);
    expect(colors[0]).not.toBe(colors[2]);
    expect(model.series.some((s) => s.area)).toBe(false);
    expect(model.yMax).toBe(200);
    const gainLimits = new Set(model.annotations.map((a) => a.limit));
    expect(gainLimits).toEqual(new Set(['Weekly', 'Weekly · Fable']));
  });

  test('accounts view tells limits apart by color and accounts by opacity', () => {
    const model = buildChartModel({
      accounts: both,
      now,
      settings: { ...settings, view: 'accounts' },
    });
    const recorded = model.series.filter((s) => s.role === 'account');
    expect(recorded.map((s) => [s.limit, s.name])).toEqual([
      ['Weekly', 'A'],
      ['Weekly', 'B'],
      ['Weekly · Fable', 'A'],
      ['Weekly · Fable', 'B'],
    ]);
    expect(recorded[0].color).toBe(recorded[1].color);
    expect(recorded[0].color).not.toBe(recorded[2].color);
    expect(recorded[0].opacity).toBe(1);
    expect(recorded[1].opacity).toBeLessThan(1);
    const dashed = model.series.filter((s) => s.dashed);
    expect(dashed).toHaveLength(4);
    expect(dashed.every((s) => s.hideLegend)).toBe(true);
  });

  test('a single limit keeps each account its own color', () => {
    const model = buildChartModel({
      accounts: both,
      now,
      settings: { ...settings, limits: ['Weekly'], view: 'accounts' },
    });
    const recorded = model.series.filter((s) => s.role === 'account');
    expect(recorded[0].color).not.toBe(recorded[1].color);
    expect(recorded.every((s) => s.opacity === undefined)).toBe(true);
  });

  test('keeps a projection only for limits with a period, and the horizon follows', () => {
    const model = buildChartModel({
      accounts: both,
      now,
      settings: { ...settings, limits: ['Weekly', '5-hour'] },
    });
    expect(model.limits.map((l) => l.projection != null)).toEqual([true, false]);
    expect(model.x1).toBe(now + WEEK);
    expect(model.series.filter((s) => s.limit === '5-hour').map((s) => s.role)).toEqual([
      'recorded',
    ]);
  });

  test('drain view plots every selected limit on one scale', () => {
    const model = buildChartModel({
      accounts: both,
      now,
      settings: { ...settings, metric: 'drain' },
    });
    expect(model.unit).toBe('%/h');
    expect(model.series.filter((s) => s.role === 'drain').map((s) => s.limit)).toEqual([
      'Weekly',
      'Weekly · Fable',
    ]);
    expect(model.limits.every((l) => l.burn.rate >= 0)).toBe(true);
  });
});

describe('placeLabels', () => {
  const bounds = { minX: 0, maxX: 400 };
  const spec = (x: number, y: number) => ({
    x,
    y,
    width: textWidth('+100%', 11),
    size: 11,
    tries: GAIN_TRIES,
  });

  test('moves a label off the "Now" caption instead of printing over it', () => {
    const now = textBox(100, 14, textWidth('Now', 11), 11, 'middle');
    const [placed] = placeLabels([spec(102, 24)], [now], bounds);
    expect(placed).not.toBeNull();
    const box = textBox(placed!.x, placed!.y, textWidth('+100%', 11), 11, placed!.anchor);
    expect(box.y1 < now.y0 || box.y0 > now.y1 || box.x0 > now.x1 || box.x1 < now.x0).toBe(true);
  });

  test('stacks labels that share a spot and drops the ones with no room', () => {
    const placed = placeLabels([spec(200, 60), spec(200, 60), spec(200, 60)], [], bounds);
    expect(placed.map((p) => p?.y)).toEqual([53, 36, 74]);
    const crowded = placeLabels(
      [spec(200, 60), spec(200, 60), spec(200, 60), spec(200, 60), spec(200, 60)],
      [],
      bounds
    );
    expect(crowded.filter(Boolean).length).toBeLessThan(5);
    expect(crowded.at(-1)).toBeNull();
  });

  test('keeps labels inside the chart bounds', () => {
    const [placed] = placeLabels([spec(395, 60)], [], bounds);
    expect(placed?.anchor).toBe('end');
  });
});
