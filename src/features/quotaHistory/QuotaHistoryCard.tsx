import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import iconClaude from '@/assets/icons/claude.svg';
import iconCodex from '@/assets/icons/codex.svg';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw, IconSettings } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import type { QuotaHistoryErrorKind } from './api';
import {
  BURN_HOURS,
  FUTURE_FACTORS,
  HISTORY_DAYS,
  buildChartModel,
  sanitizeSettings,
  toggleLimit,
  type ChartSettings,
  type FutureFactor,
  type Metric,
  type View,
} from './chartModel';
import {
  formatDuration,
  formatMonthDay,
  formatWhen,
  legendItems,
  limitDisplayName,
} from './format';
import './i18n';
import { limitLabels } from './model';
import { limitColor } from './palette';
import { QuotaHistoryChart } from './QuotaHistoryChart';
import { readStoredSettings, writeStoredSettings } from './storage';
import type { DrainOrder, HistoryProvider, QuotaHistory } from './types';
import { useNow } from '@/hooks/useNow';
import styles from './QuotaHistoryCard.module.scss';

const PROVIDERS: Record<HistoryProvider, { name: string; icon: string; drain: DrainOrder }> = {
  claude: { name: 'Claude', icon: iconClaude, drain: 'soonestReset' },
  codex: { name: 'Codex', icon: iconCodex, drain: 'priority' },
};

export interface HistoryServiceControls {
  /** Saved address, or '' when the panel looks the service up itself. */
  override: string;
  /** Shown as the input placeholder: the addresses tried in order. */
  automatic: string;
  save: (url: string) => void;
  reset: () => void;
}

interface Props {
  provider: HistoryProvider;
  /** The whole history response; the card charts only its provider's accounts. */
  data: QuotaHistory | null;
  error: QuotaHistoryErrorKind | null;
  loading: boolean;
  reload: () => void;
  service: HistoryServiceControls;
  /** Reports the card's history range so the shared request covers it. */
  onDaysChange: (provider: HistoryProvider, days: number) => void;
}

const STALE_AFTER_SECONDS = 15 * 60;

interface SegmentedProps<T extends string> {
  label?: string;
  ariaLabel: string;
  /** Pressed option; a multi-select picker passes `values` instead. */
  value?: T;
  values?: readonly T[];
  options: ReadonlyArray<{ value: T; label: string; color?: string }>;
  onChange: (value: T) => void;
}

function Segmented<T extends string>({
  label,
  ariaLabel,
  value,
  values,
  options,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className={styles.group} role="group" aria-label={ariaLabel}>
      {label && <span className={styles.groupName}>{label}</span>}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={values ? values.includes(option.value) : value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.color && <i className={styles.swatch} style={{ background: option.color }} />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function QuotaHistoryCard({
  provider,
  data,
  error,
  loading,
  reload,
  service,
  onDaysChange,
}: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const nowMs = useNow(true);
  const meta = PROVIDERS[provider];

  const [draftUrl, setDraftUrl] = useState('');
  const [editingService, setEditingService] = useState(false);
  const [stored, setStored] = useState<unknown>(() => readStoredSettings(provider));

  const accounts = useMemo(
    () => (data?.accounts ?? []).filter((account) => account.provider === provider),
    [data, provider]
  );
  const settings = useMemo(() => sanitizeSettings(stored, accounts), [stored, accounts]);
  const labels = useMemo(() => limitLabels(accounts), [accounts]);
  const model = useMemo(
    () => (data ? buildChartModel({ accounts, now: data.now, settings, drain: meta.drain }) : null),
    [data, accounts, settings, meta.drain]
  );

  const update = useCallback(
    (patch: Partial<ChartSettings>) => {
      const next = { ...settings, ...patch };
      setStored(next);
      writeStoredSettings(provider, next);
      if (patch.historyDays !== undefined) onDaysChange(provider, patch.historyDays);
    },
    [settings, provider, onDaysChange]
  );

  const saveService = () => {
    service.save(draftUrl);
    setEditingService(false);
  };
  const resetService = () => {
    service.reset();
    setDraftUrl('');
    setEditingService(false);
  };
  const toggleService = () => {
    setDraftUrl(service.override);
    setEditingService((open) => !open);
  };

  const settingsButton = (
    <button
      type="button"
      className={styles.iconButton}
      aria-label={t('quota_history.service_settings')}
      title={t('quota_history.service_settings')}
      aria-expanded={editingService}
      onClick={toggleService}
    >
      <IconSettings size={16} />
    </button>
  );

  const serviceForm = editingService && (
    <form
      className={styles.serviceForm}
      onSubmit={(event) => {
        event.preventDefault();
        saveService();
      }}
    >
      <label className={styles.serviceLabel}>
        <span>{t('quota_history.service_url')}</span>
        <input
          className="input"
          value={draftUrl}
          placeholder={service.automatic}
          onChange={(event) => setDraftUrl(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <div className={styles.serviceActions}>
        <Button type="submit" size="sm">
          {t('quota_history.service_save')}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={resetService}>
          {t('quota_history.service_default')}
        </Button>
      </div>
      <p className={styles.hint}>{t('quota_history.service_hint')}</p>
    </form>
  );

  const header = (
    <div className={styles.head}>
      <img className={styles.providerIcon} src={meta.icon} alt="" />
      <span className={styles.providerName}>{meta.name}</span>
      <span className={styles.muted}>
        {t('quota_history.title')}
        {model
          ? ` · ${t(
              model.accountCount === 1
                ? 'quota_history.accounts_single'
                : 'quota_history.accounts_many',
              { n: model.accountCount }
            )}`
          : ''}
      </span>
      <span className={styles.spacer} />
      {settingsButton}
    </div>
  );

  if (!data) {
    if (loading || !error) {
      return (
        <section className={styles.card} aria-busy="true" aria-label={t('quota_history.loading')}>
          {header}
          {serviceForm}
          <Skeleton height={260} rounded={10} />
        </section>
      );
    }
    return (
      <section className={styles.card} aria-label={t('quota_history.title')}>
        {header}
        {serviceForm}
        <div className={styles.empty} role="status">
          <div className={styles.emptyTitle}>
            {t(
              error === 'unauthorized'
                ? 'quota_history.unauthorized_title'
                : 'quota_history.unavailable_title'
            )}
          </div>
          <div className={styles.muted}>
            {t(
              error === 'unauthorized'
                ? 'quota_history.unauthorized_desc'
                : 'quota_history.unavailable_desc'
            )}
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={reload} loading={loading}>
            {t('quota_history.retry')}
          </Button>
        </div>
      </section>
    );
  }

  if (!model || model.accountCount === 0) {
    return (
      <section className={styles.card} aria-label={t('quota_history.title')}>
        {header}
        {serviceForm}
        <div className={styles.empty} role="status">
          <div className={styles.emptyTitle}>{t('quota_history.empty_title')}</div>
          <div className={styles.muted}>{t('quota_history.empty_desc')}</div>
        </div>
      </section>
    );
  }

  const multi = model.limits.length > 1;
  const horizon = formatMonthDay(model.x1, locale);
  const when = (time: number) => formatWhen(time, model.now, locale, t);
  const rows = model.limits.map((limit) => {
    const { burn, projection } = limit;
    const stats: Array<[string, string]> = [];
    const next = limit.states
      .filter((state) => state.reset && state.reset > model.now)
      .sort((a, b) => (a.reset ?? 0) - (b.reset ?? 0))[0];
    if (projection) {
      stats.push([
        t('quota_history.stat_pool_empty'),
        projection.poolEmpty
          ? when(projection.poolEmpty)
          : t('quota_history.not_by', { date: horizon }),
      ]);
      stats.push([
        t('quota_history.stat_first_empty'),
        projection.firstEmpty
          ? t('quota_history.first_empty_value', {
              name: projection.firstEmpty.name,
              in: formatDuration(projection.firstEmpty.t - model.now, t),
            })
          : t('quota_history.none_by', { date: horizon }),
      ]);
      if (next && next.reset) {
        stats.push([
          t('quota_history.stat_next_reset'),
          t('quota_history.next_reset_gain', {
            gain: Math.round(100 - next.rem),
            when: when(next.reset),
          }),
        ]);
      }
    } else {
      stats.push([
        t('quota_history.stat_next_reset'),
        next && next.reset
          ? t('quota_history.next_reset_account', { name: next.name, when: when(next.reset) })
          : t('quota_history.no_window'),
      ]);
    }
    const burnLabel =
      burn.source === 'window'
        ? t('quota_history.burn_window', { hours: burn.hours })
        : burn.source === 'weekAverage'
          ? t('quota_history.burn_week')
          : burn.source === 'collecting'
            ? t('quota_history.burn_collecting')
            : t('quota_history.burn_none');
    stats.push([burnLabel, `${burn.rate.toFixed(1)}%/h`]);
    return { limit, stats };
  });

  const newest = Math.max(0, ...accounts.map((account) => account.sampled ?? 0));
  const ageSeconds = newest ? nowMs / 1000 - newest : 0;
  const freshness = !newest
    ? null
    : ageSeconds > STALE_AFTER_SECONDS
      ? { stale: true, text: t('quota_history.stale', { age: formatDuration(ageSeconds, t) }) }
      : { stale: false, text: t('quota_history.updated', { age: formatDuration(ageSeconds, t) }) };

  const limitOptions = labels.map((label) => ({
    value: label,
    label: limitDisplayName(label, t),
    color: limitColor(label, labels),
  }));
  const futureLabels: Record<FutureFactor, string> = {
    '1': t('quota_history.future_same'),
    '0.5': t('quota_history.future_half'),
    '2': t('quota_history.future_double'),
    '0': t('quota_history.future_idle'),
  };

  return (
    <section className={styles.card} aria-label={t('quota_history.title')}>
      {header}
      {serviceForm}

      <div className={styles.controls}>
        <Segmented<string>
          label={t('quota_history.control_limit')}
          ariaLabel={t('quota_history.control_limit')}
          values={settings.limits}
          onChange={(limit) => update({ limits: toggleLimit(settings.limits, limit, labels) })}
          options={limitOptions}
        />
        <Segmented<Metric>
          ariaLabel={t('quota_history.metric_remaining')}
          value={settings.metric}
          onChange={(metric) => update({ metric })}
          options={[
            { value: 'remaining', label: t('quota_history.metric_remaining') },
            { value: 'drain', label: t('quota_history.metric_drain') },
          ]}
        />
        <Segmented<string>
          label={t('quota_history.control_burn')}
          ariaLabel={t('quota_history.control_burn')}
          value={String(settings.burnHours)}
          onChange={(value) => update({ burnHours: Number(value) })}
          options={BURN_HOURS.map((hours) => ({
            value: String(hours),
            label: t('quota_history.hours_short', { n: hours }),
          }))}
        />
        {model.limits.some((limit) => limit.period) && (
          <div className={styles.selectGroup}>
            <span className={styles.groupName}>{t('quota_history.control_future')}</span>
            <Select
              size="sm"
              fullWidth={false}
              value={settings.future}
              options={FUTURE_FACTORS.map((value) => ({ value, label: futureLabels[value] }))}
              onChange={(future) => update({ future: future as FutureFactor })}
              ariaLabel={t('quota_history.control_future')}
            />
          </div>
        )}
        {settings.metric === 'remaining' && (
          <Segmented<View>
            ariaLabel={t('quota_history.view_pool')}
            value={settings.view}
            onChange={(view) => update({ view })}
            options={[
              { value: 'pool', label: t('quota_history.view_pool') },
              { value: 'accounts', label: t('quota_history.view_accounts') },
            ]}
          />
        )}
        <span className={styles.spacer} />
        <Segmented<string>
          label={t('quota_history.control_history')}
          ariaLabel={t('quota_history.control_history')}
          value={String(settings.historyDays)}
          onChange={(value) => update({ historyDays: Number(value) })}
          options={HISTORY_DAYS.map((count) => ({
            value: String(count),
            label: t('quota_history.days_short', { n: count }),
          }))}
        />
      </div>

      <div className={styles.summaries}>
        {rows.map(({ limit, stats }) => (
          <div key={limit.label} className={multi ? styles.summaryRow : styles.summary}>
            {multi && (
              <span className={styles.limitName}>
                <i className={styles.swatch} style={{ background: limit.color }} />
                {limitDisplayName(limit.label, t)}
              </span>
            )}
            <div className={multi ? styles.bigCompact : styles.big}>
              {Math.round(limit.current)}%
              <small>{t('quota_history.of_left', { total: limit.accountCount * 100 })}</small>
            </div>
            <dl className={styles.stats}>
              {stats.map(([name, value]) => (
                <div key={name} className={styles.stat}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      {error && (
        <div className={styles.notice} role="alert">
          {t('quota_history.refresh_failed')}
        </div>
      )}

      <QuotaHistoryChart model={model} locale={locale} />

      <div className={styles.legend}>
        {legendItems(model.series, multi, t).map((item, index) => (
          <span key={index} className={styles.legendItem}>
            <i
              style={{
                borderTopColor: item.color,
                borderTopStyle: item.dashed ? 'dashed' : 'solid',
                opacity: item.opacity,
              }}
            />
            {item.text}
          </span>
        ))}
        <span className={styles.spacer} />
        {freshness && (
          <span className={freshness.stale ? styles.stale : undefined}>{freshness.text}</span>
        )}
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('quota_history.retry')}
          title={t('quota_history.retry')}
          onClick={reload}
          disabled={loading}
        >
          <IconRefreshCw size={14} />
        </button>
      </div>
      <p className={styles.footnote}>
        {t(provider === 'codex' ? 'quota_history.footnote_codex' : 'quota_history.footnote')}
      </p>
    </section>
  );
}
