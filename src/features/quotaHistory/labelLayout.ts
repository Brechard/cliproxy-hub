/** Collision-free placement for the small text labels drawn on the chart. */

export type Anchor = 'start' | 'middle' | 'end';

export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface LabelSpec {
  x: number;
  y: number;
  width: number;
  size: number;
  /** Placements to try in order, as offsets from (x, y). */
  tries: ReadonlyArray<readonly [dx: number, dy: number, anchor: Anchor]>;
}

export interface PlacedLabel {
  x: number;
  y: number;
  anchor: Anchor;
}

/** Reset-jump labels: above the point, nudged sideways, stacked above, then below it. */
export const GAIN_TRIES: LabelSpec['tries'] = [
  [0, -7, 'middle'],
  [3, -7, 'start'],
  [-3, -7, 'end'],
  [0, -24, 'middle'],
  [4, 14, 'start'],
  [-4, 14, 'end'],
];

/** Pool-empty labels sit above their ring. */
export const RING_TRIES: LabelSpec['tries'] = [
  [0, -10, 'middle'],
  [-8, -10, 'end'],
  [8, -10, 'start'],
  [0, -26, 'middle'],
];

const PAD = 2;

/** Rough text width; the chart's fonts are proportional, so this errs slightly wide. */
export const textWidth = (text: string, size: number): number => text.length * size * 0.6;

export const textBox = (x: number, y: number, width: number, size: number, anchor: Anchor): Box => {
  const x0 = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2;
  return { x0, x1: x0 + width, y0: y - size, y1: y + size * 0.25 };
};

const overlaps = (a: Box, b: Box) =>
  a.x0 < b.x1 + PAD && b.x0 < a.x1 + PAD && a.y0 < b.y1 + PAD && b.y0 < a.y1 + PAD;

/**
 * Places labels in order, each at its first try that stays inside [minX, maxX] and clear of
 * the obstacles and earlier labels. A label with no free spot comes back null.
 */
export function placeLabels(
  specs: readonly LabelSpec[],
  obstacles: readonly Box[],
  bounds: { minX: number; maxX: number }
): Array<PlacedLabel | null> {
  const taken = [...obstacles];
  return specs.map((spec) => {
    for (const [dx, dy, anchor] of spec.tries) {
      const x = spec.x + dx;
      const y = spec.y + dy;
      const box = textBox(x, y, spec.width, spec.size, anchor);
      if (box.x0 < bounds.minX || box.x1 > bounds.maxX || box.y0 < 0) continue;
      if (taken.some((other) => overlaps(box, other))) continue;
      taken.push(box);
      return { x, y, anchor };
    }
    return null;
  });
}
