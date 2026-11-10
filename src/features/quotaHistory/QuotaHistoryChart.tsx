import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { xTicks, type ChartModel, type ChartSeries } from './chartModel';
import { formatDay, formatTime, formatWhen, limitDisplayName, seriesDisplayName } from './format';
import {
  GAIN_TRIES,
  RING_TRIES,
  placeLabels,
  textBox,
  textWidth,
  type Anchor,
  type LabelSpec,
} from './labelLayout';
import { interp } from './model';
import styles from './QuotaHistoryCard.module.scss';

const MARGIN = { l: 48, r: 14, t: 24, b: 28 };
const MIN_TICK_GAP = 52;

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
  const multi = model.limits.length > 1;

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
    const nowDots = model.series
      .filter((series) => !series.dashed)
      .map((series) => ({ series, value: interp(series.pts, now) }))
      .filter((dot): dot is { series: ChartSeries; value: number } => dot.value != null)
      .map(({ series, value }) => ({ x: x(now), y: y(value), series }));

    const inRange = [...model.annotations]
      .filter((a) => a.t >= x0 && a.t <= x1)
      .sort((p, q) => p.t - q.t);
    const empties = inRange.filter((a) => a.kind === 'empty');
    const emptyTexts = empties.map((a) => {
      const text = t('quota_history.empty_when', { when: formatWhen(a.t, now, locale, t) });
      return multi ? `${limitDisplayName(a.limit, t)} · ${text}` : text;
    });
    const gains = inRange.filter((a) => a.kind === 'gain');
    const nowText = t('quota_history.now');
    const obstacles = [
      textBox(x(now), MARGIN.t - 10, textWidth(nowText, 11), 11, 'middle'),
      ...empties.map((a) => ({ x0: x(a.t) - 6, x1: x(a.t) + 6, y0: y(a.v) - 6, y1: y(a.v) + 6 })),
    ];
    const specs: LabelSpec[] = [
      ...empties.map((a, i): LabelSpec => ({
        x: x(a.t),
        y: y(a.v),
        width: textWidth(emptyTexts[i], 12),
        size: 12,
        tries: RING_TRIES,
      })),
      ...gains.map((a): LabelSpec => ({
        x: x(a.t),
        y: y(a.v),
        width: textWidth(`+${Math.round(a.gain ?? 0)}%`, 11),
        size: 11,
        tries: GAIN_TRIES,
      })),
    ];
    const placed = placeLabels(specs, obstacles, { minX: 0, maxX: width });
    const labels: {
      x: number;
      y: number;
      text: string;
      ring: boolean;
      color?: string;
      anchor: Anchor;
      ringX?: number;
      ringY?: number;
    }[] = [];
    [...empties, ...gains].forEach((a, i) => {
      const spot = placed[i];
      if (!spot) return;
      const ring = a.kind === 'empty';
      labels.push({
        ...spot,
        text: ring ? emptyTexts[i] : `+${Math.round(a.gain ?? 0)}%`,
        ring,
        color: a.color,
        ringX: x(a.t),
        ringY: y(a.v),
      });
    });
    return {
      x,
      y,
      grid,
      ticks,
      paths,
      labels,
      nowX: x(now),
      nowDots,
    };
  }, [model, multi, x0, x1, yMax, unit, now, width, height, locale, t]);

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
          label: model.limits.map((limit) => limitDisplayName(limit.label, t)).join(', '),
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
                opacity={series.opacity}
              />
            </g>
          );
        })}
        <line
          className={styles.nowLine}
          x1={plot.nowX}
          x2={plot.nowX}
          y1={MARGIN.t - 6}
          y2={height - MARGIN.b}
        />
        <text className={styles.axis} x={plot.nowX} y={MARGIN.t - 10} textAnchor="middle">
          {t('quota_history.now')}
        </text>
        {plot.nowDots.map((dot, i) => (
          <circle
            key={i}
            cx={dot.x}
            cy={dot.y}
            r={3.5}
            fill={dot.series.color}
            opacity={dot.series.opacity}
          />
        ))}
        {plot.labels.map((label, i) =>
          label.ring ? (
            <g key={i}>
              <circle
                className={styles.ring}
                cx={label.ringX}
                cy={label.ringY}
                r={5}
                style={label.color ? { stroke: label.color } : undefined}
              />
              <text className={styles.ringText} x={label.x} y={label.y} textAnchor={label.anchor}>
                {label.text}
              </text>
            </g>
          ) : (
            <text
              key={i}
              className={styles.gain}
              x={label.x}
              y={label.y}
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
              <span className={styles.tipName}>{seriesDisplayName(series, t, multi)}</span>
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
