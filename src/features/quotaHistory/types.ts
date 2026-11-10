/** One recorded reading: epoch seconds, used percent (0-100), reset epoch seconds or null. */
export type SeriesPoint = [t: number, used: number, reset: number | null];

export interface LatestLimit {
  label: string;
  percent: number;
  reset: number | null;
}

export interface HistoryAccount {
  name: string;
  priority: number | null;
  sampled: number | null;
  latest: LatestLimit[];
  series: Record<string, SeriesPoint[]>;
}

export interface QuotaHistory {
  /** Server clock, epoch seconds. Everything "now" in the chart is relative to this. */
  now: number;
  accounts: HistoryAccount[];
}

export interface RemainingPoint {
  t: number;
  v: number;
  /** Set on the upward step of a reset: how many percent the reset refilled. */
  gain?: number;
}

export interface Line {
  name: string;
  color: string;
  pts: RemainingPoint[];
}

export interface Gain {
  t: number;
  v: number;
  gain: number;
  name?: string;
}

export interface AccountState {
  name: string;
  color: string;
  rem: number;
  reset: number | null;
}

export interface ProjectedAccount extends AccountState {
  pts: RemainingPoint[];
}

export interface Projection {
  accs: ProjectedAccount[];
  pool: RemainingPoint[];
  gains: Gain[];
  firstEmpty: { t: number; name: string } | null;
  poolEmpty: number | null;
}

export type BurnSource = 'window' | 'weekAverage' | 'collecting' | 'none';

export interface BurnRate {
  rate: number;
  source: BurnSource;
  hours: number;
}
