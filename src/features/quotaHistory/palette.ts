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
