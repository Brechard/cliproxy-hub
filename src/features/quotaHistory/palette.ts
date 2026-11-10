/**
 * Per-account line colors for the Accounts view. The first entry is Claude's brand
 * orange (the same fill as `assets/icons/claude.svg`) and doubles as the pool accent.
 */
export const ACCOUNT_PALETTE = [
  '#d97757',
  '#60a5fa',
  '#a78bfa',
  '#34d399',
  '#f472b6',
  '#fbbf24',
] as const;

export const accountColor = (index: number): string =>
  ACCOUNT_PALETTE[index % ACCOUNT_PALETTE.length];

const MODEL_LIMIT_PALETTE = ['#a78bfa', '#34d399', '#f472b6', '#fbbf24'] as const;

/**
 * One color per limit, stable while other limits come and go: Weekly keeps the brand
 * orange, 5-hour is blue and model-scoped limits take the rest in label order.
 */
export const limitColor = (label: string, labels: readonly string[]): string => {
  if (label === 'Weekly') return ACCOUNT_PALETTE[0];
  if (label === '5-hour') return ACCOUNT_PALETTE[1];
  const index = labels.filter((l) => l !== 'Weekly' && l !== '5-hour').indexOf(label);
  return MODEL_LIMIT_PALETTE[Math.max(0, index) % MODEL_LIMIT_PALETTE.length];
};

/** Accounts share a limit's color and fade by position so their lines stay apart. */
export const accountOpacity = (index: number): number => Math.max(0.35, 1 - index * 0.22);
