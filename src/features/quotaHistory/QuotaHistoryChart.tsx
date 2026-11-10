import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { xTicks, type ChartModel, type ChartSeries } from './chartModel';
import { formatDay, formatTime, formatWhen, limitDisplayName, seriesDisplayName } from './format';
import { interp } from './model';
import styles from './QuotaHistoryCard.module.scss';

const MARGIN = { l: 48, r: 14, t: 24, b: 28 };
const MIN_TICK_GAP = 52;
const MIN_LABEL_GAP = 34;

interface Props {
  model: ChartModel;
  locale: string;
}

const roundTick = (v: number) => Math.round(v * 10) / 10;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.floor(el.clientWidth));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function QuotaHistoryChart({ model, locale }: Props) {
  const { t } = useTranslation();
  const gradientBase = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [wrapRef, measured] = useWidth();
  const [hover, setHover] = useState<{ px: number; time: number } | null>(null);
  const width = Math.max(260, measured);
  const height = width < 560 ? 230 : 300;
  const { x0, x1, yMax, unit, now } = model;

  const plot = useMemo(() => {
    const x = (time: number) =>
      MARGIN.l + ((time - x0) / (x1 - x0)) * (width - MARGIN.l - MARGIN.r);
    const y = (v: number) =>
      MARGIN.t + (1 - Math.min(Math.max(v, 0), yMax) / yMax) * (height - MARGIN.t - MARGIN.b);
    const clip = (pts: ChartSeries['pts']) => {
      const inside = pts.filter((p) => p.t >= x0 && p.t <= x1);
      const before = pts.filter((p) => p.t < x0).pop();
      return before ? [{ t: x0, v: interp(pts, x0) ?? before.v }, ...inside] : inside;
    };
    const d = (pts: ChartSeries['pts']) =>
      pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');

    const grid = [0, 0.5, 1].map((f) => ({
      y: y(yMax * f),
      label: `${roundTick(yMax * f)}${unit}`,
    }));
    const ticks: { x: number; label: string }[] = [];
    let lastTickX = -Infinity;
    for (const tick of xTicks(x0, x1)) {
      const tx = x(tick.t);
      if (tx - lastTickX < MIN_TICK_GAP) continue;
      lastTickX = tx;
      ticks.push({
        x: tx,
        label: tick.day ? formatDay(tick.t, locale) : formatTime(tick.t, locale),
      });
    }
    const paths = model.series.map((series, index) => {
      const pts = clip(series.pts);
      if (!pts.length) return null;
      if (pts.length === 1) return { dot: { x: x(pts[0].t), y: y(pts[0].v) }, series, index };
      const line = d(pts);
      const area = series.area
        ? `${line}L${x(pts[pts.length - 1].t)},${y(0)}L${x(pts[0].t)},${y(0)}Z`
        : null;
      return { line, area, series, index };
    });
    const nowValue = model.series[0] ? interp(model.series[0].pts, now) : null;
    let lastLabelX = -Infinity;
    const labels: {
      x: number;
      y: number;
      text: string;
      ring: boolean;
      color?: string;
      anchor: 'start' | 'middle' | 'end';
    }[] = [];
    for (const a of [...model.annotations]
      .filter((n) => n.t >= x0 && n.t <= x1)
      .sort((p, q) => p.t - q.t)) {
      const ax = x(a.t);
      if (a.kind === 'empty') {
        const edge = width - MARGIN.r - 90;
        labels.push({
          x: ax,
          y: y(a.v),
          text: t('quota_history.empty_when', { when: formatWhen(a.t, now, locale, t) }),
          ring: true,
          anchor: ax > edge ? 'end' : 'middle',
        });
        continue;
      }
      if (ax - lastLabelX < MIN_LABEL_GAP) continue;
      lastLabelX = ax;
      labels.push({
        x: ax,
        y: y(a.v),
        text: `+${Math.round(a.gain ?? 0)}%`,
        ring: false,
        color: a.color,
        anchor: 'middle',
      });
    }
    return {
      x,
      y,
      grid,
      ticks,
      paths,
      labels,
      now: { x: x(now), y: nowValue == null ? null : y(nowValue) },
    };
  }, [model, x0, x1, yMax, unit, now, width, height, locale, t]);

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const px = ((event.clientX - rect.left) / rect.width) * width;
    if (px < MARGIN.l || px > width - MARGIN.r) {
      setHover(null);
      return;
    }
    const time = x0 + ((px - MARGIN.l) / (width - MARGIN.l - MARGIN.r)) * (x1 - x0);
    setHover({ px, time });
  };

  const tooltipRows = hover
    ? model.series
        .filter((series) => hover.time <= now !== Boolean(series.dashed))
        .map((series) => ({ series, v: interp(series.pts, hover.time) }))
        .filter((row): row is { series: ChartSeries; v: number } => row.v != null)
    : [];
  const showTooltip = hover !== null && tooltipRows.length > 0;
  const tipWidth = 200;
  const tipLeft = hover ? Math.min(Math.max(hover.px + 12, 0), Math.max(0, width - tipWidth)) : 0;

  return (
    <div ref={wrapRef} className={styles.chart}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={t('quota_history.chart_label', {
          label: limitDisplayName(model.label, t),
        })}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      >
        <defs>
          {model.series.map((series, i) => (
            <linearGradient key={i} id={`${gradientBase}${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={series.color} stopOpacity={series.dashed ? 0.12 : 0.28} />
              <stop offset="1" stopColor={series.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {plot.grid.map((line, i) => (
          <g key={i}>
            <line
              className={styles.grid}
              x1={MARGIN.l}
              x2={width - MARGIN.r}
              y1={line.y}
              y2={line.y}
            />
            <text className={styles.axis} x={MARGIN.l - 8} y={line.y + 4} textAnchor="end">
              {line.label}
            </text>
          </g>
        ))}
        {plot.ticks.map((tick, i) => (
          <g key={i}>
            <line
              className={styles.grid}
              x1={tick.x}
              x2={tick.x}
              y1={MARGIN.t}
              y2={height - MARGIN.b}
            />
            <text className={styles.axis} x={tick.x} y={height - 8} textAnchor="middle">
              {tick.label}
            </text>
          </g>
        ))}
        {plot.paths.map((path) => {
          if (!path) return null;
          const { series, index } = path;
          if ('dot' in path && path.dot) {
            return <circle key={index} cx={path.dot.x} cy={path.dot.y} r={3} fill={series.color} />;
          }
          return (
            <g key={index}>
              {path.area && <path d={path.area} fill={`url(#${gradientBase}${index})`} />}
              <path
                d={path.line}
                fill="none"
                stroke={series.color}
                strokeWidth={1.8}
                strokeLinejoin="round"
                strokeDasharray={series.dashed ? '5 4' : undefined}
              />
            </g>
          );
        })}
        <line
          className={styles.nowLine}
          x1={plot.now.x}
          x2={plot.now.x}
          y1={MARGIN.t - 6}
          y2={height - MARGIN.b}
        />
        <text className={styles.axis} x={plot.now.x} y={MARGIN.t - 10} textAnchor="middle">
          {t('quota_history.now')}
        </text>
        {plot.now.y != null && model.series[0] && (
          <circle cx={plot.now.x} cy={plot.now.y} r={3.5} fill={model.series[0].color} />
        )}
        {plot.labels.map((label, i) =>
          label.ring ? (
            <g key={i}>
              <circle className={styles.ring} cx={label.x} cy={label.y} r={5} />
              <text
                className={styles.ringText}
                x={label.x}
                y={label.y - 10}
                textAnchor={label.anchor}
              >
                {label.text}
              </text>
            </g>
          ) : (
            <text
              key={i}
              className={styles.gain}
              x={label.x}
              y={label.y - 7}
              textAnchor={label.anchor}
              fill={label.color}
            >
              {label.text}
            </text>
          )
        )}
        {hover && (
          <line
            className={styles.cursor}
            x1={hover.px}
            x2={hover.px}
            y1={MARGIN.t}
            y2={height - MARGIN.b}
          />
        )}
      </svg>
      {showTooltip && hover && (
        <div className={styles.tip} style={{ left: tipLeft }} role="status">
          <div className={styles.tipTime}>
            {formatDay(hover.time, locale)} {formatTime(hover.time, locale)}
            {hover.time > now ? ` · ${t('quota_history.tooltip_projected')}` : ''}
          </div>
          {tooltipRows.map(({ series, v }, i) => (
            <div key={i} className={styles.tipRow}>
              <span className={styles.dot} style={{ background: series.color }} />
              <span className={styles.tipName}>{seriesDisplayName(series, t)}</span>
              <b>
                {v.toFixed(1)}
                {unit}
              </b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
