// The run token TTL follows this.
export const WORKER_TIMEOUT_BUDGET_MS = positiveIntegerEnv(
  "WORKER_TIMEOUT_BUDGET_MS",
  10 * 60 * 1000,
);
// An hour at the default budget, so a run that never ends still stops costing tokens.
export const MAX_RUN_SLOTS = positiveIntegerEnv("MAX_RUN_SLOTS", 6);

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);

  return value;
}

/** A rotatable secret: comma-separated, first entry seals, every entry opens. */
export function requireSecretsEnv(name: string): [string, ...string[]] {
  const [first, ...rest] = [
    ...new Set(
      requireEnv(name)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (!first) throw new Error(`Missing required environment variable: ${name}`);

  return [first, ...rest];
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];

  return value ? value : undefined;
}

export function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  const parsed = raw === undefined ? fallback : Number(raw);

  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

export function getHarnessPublicUrl(): string | undefined {
  const configured = optionalEnv("PUBLIC_BASE_URL");

  return configured ? configured.replace(/\/+$/, "") : undefined;
}

export function booleanEnv(name: string, defaultValue = false): boolean {
  const value = optionalEnv(name);
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean-like value`);
}
