export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right): number => left - right);

  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ]!;
}
