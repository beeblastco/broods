/**
 * Core's logger writes one JSON line per event straight to stdout, and a case
 * that drives real core code (the isolate tier, an agent run) produces
 * hundreds of them. They would drown the report, so a case that needs it
 * swaps stdout out for the measurement and puts it back after.
 */

const originalWrite = process.stdout.write.bind(process.stdout);

let muted = false;

/** Drop JSON log lines on the floor; pass anything else through. */
export function muteCoreLogs(): void {
  if (muted) return;
  muted = true;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (text.startsWith('{"') && text.includes('"level":')) return true;

    return originalWrite(chunk);
  }) as typeof process.stdout.write;
}

export function unmuteCoreLogs(): void {
  if (!muted) return;
  muted = false;
  process.stdout.write = originalWrite as typeof process.stdout.write;
}
