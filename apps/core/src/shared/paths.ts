// Scanned, not `replace(/\/+$/, "")`: that regex is quadratic on a long run of slashes.
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;

  return value.slice(0, end);
}
