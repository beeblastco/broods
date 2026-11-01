const originalWrite = process.stdout.write.bind(process.stdout);

let muted = false;

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
