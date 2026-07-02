/**
 * Shared environment helpers.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

// True in the deployed runtimes (Lambda, or the self-hosted container which
// sets BROODS_CONTAINER_RUNTIME), false in tests/local dev. Gates side effects
// that must not fire outside a deployment, like sandbox prewarm.
export function isDeployedRuntime(): boolean {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.BROODS_CONTAINER_RUNTIME);
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
