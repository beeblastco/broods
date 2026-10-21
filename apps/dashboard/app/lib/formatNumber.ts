// Compact count for headers and table cells, e.g. 48.8K or 1.2M. The cutoffs
// sit where one decimal rounds up, so 999,950 reads 1.0M and never 1000.0K.
// Below 1K it is a whole number, also for an average or a value mid-tween.
export function formatNumber(n: number): string {
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 999.5) return `${(n / 1_000).toFixed(1)}K`;

  return Math.round(n).toLocaleString();
}
