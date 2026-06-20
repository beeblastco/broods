/**
 * Shared logging helpers. Every line is redacted here — the single chokepoint —
 * then emitted in order: stdout (CloudWatch fallback, all levels), OTLP
 * (best-effort, all levels), and NATS (INFO/WARN/ERROR only, requires an
 * observability context from setObservabilityContext()).
 */

import { emitOtelLog, getObservabilityContext } from "./otel.ts";
import type { ObservabilityLogEntry } from "../../../../packages/filthy-panty/src/observability-contracts.ts";
import { logsSubject, getObservabilityNatsConn } from "./nats.ts";

// Keys are matched after normalizing to lowercase with hyphens/underscores
// stripped, against three lists: exact, prefix, and suffix.
const DENY_EXACT: ReadonlySet<string> = new Set([
  "authorization",
  "xapikey",        // x-api-key / x_api_key
  "apikey",
  "secret",
  "token",
  "password",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "idtoken",
  "clientsecret",
  "apisecret",
  "privatekey",
]);

// Also redact any key that starts with these prefixes (normalized, no sep).
const DENY_PREFIX: ReadonlyArray<string> = ["authorization", "xapi"];

// Redact any key ENDING in one of these (normalized). This is what catches the
// open-ended cases the exact list can't enumerate: apiToken, sessionToken,
// natsToken, webhookSecret, dbPassword, etc. Singular "token" never matches the
// plural "tokens" of the token-count metrics (and ALLOW_EXACT guards those too).
const DENY_SUFFIX: ReadonlyArray<string> = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "secretkey",
  "privatekey",
  "accesskey",
  "credential",
  "credentials",
];

// Keys that are always safe regardless of deny matches (e.g. token-count metrics).
const ALLOW_EXACT: ReadonlySet<string> = new Set([
  "inputtokens",
  "outputtokens",
  "totaltokens",
  "cachedinputtokens",
  "cachewritetokens",
  "reasoningtokens",
  "invocations",
  "modelcalls",
]);

function isRedactedKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[-_]/g, "");
  if (ALLOW_EXACT.has(norm)) return false;
  if (DENY_EXACT.has(norm)) return true;
  for (const prefix of DENY_PREFIX) {
    if (norm.startsWith(prefix)) return true;
  }
  for (const suffix of DENY_SUFFIX) {
    if (norm.endsWith(suffix)) return true;
  }
  return false;
}

const BEARER_SECRET_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const BASIC_SECRET_PATTERN = /\bBasic\s+[^\s,;]+/gi;
const QUERY_SECRET_PATTERN = /([?&](?:access_token|api_key|apikey|key|secret|token)=)[^&#\s]+/gi;
const RUNTIME_KEY_PATTERN = /\bfp_agent_[A-Za-z0-9_-]+\b/g;

function isSensitiveEnvName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-_]/g, "");
  return isRedactedKey(name) ||
    normalized.includes("credential") ||
    normalized.includes("authorization") ||
    normalized.endsWith("headers") ||
    normalized.endsWith("providerconfigjson") ||
    normalized.endsWith("toolsjson");
}

function sensitiveEnvValues(): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || !isSensitiveEnvName(name)) continue;
    if (value.length >= 4) values.push(value);
    const authValue = value.match(/\b(?:Basic|Bearer)\s+([^,\s]+)/i)?.[1];
    if (authValue && authValue.length >= 4) values.push(authValue);
    if (value.trimStart().startsWith("{") || value.trimStart().startsWith("[")) {
      try {
        values.push(...collectSecretValues(JSON.parse(value)));
      } catch {
        // Invalid JSON is still redacted as one opaque value above.
      }
    }
  }

  return values;
}

function redactString(value: string, secretValues: readonly string[]): string {
  let redacted = value;
  const uniqueSecrets = [...new Set(secretValues.filter((secret) => secret.length >= 4))]
    .sort((left, right) => right.length - left.length);
  for (const secret of uniqueSecrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  redacted = redacted.replace(BEARER_SECRET_PATTERN, "Bearer [redacted]");
  redacted = redacted.replace(BASIC_SECRET_PATTERN, "Basic [redacted]");
  redacted = redacted.replace(QUERY_SECRET_PATTERN, "$1[redacted]");
  redacted = redacted.replace(RUNTIME_KEY_PATTERN, "[redacted]");

  return redacted;
}

/** Redact a free-form string using sensitive env values plus task-local secrets. */
export function redactSensitiveText(value: string, additionalSecretValues: readonly string[] = []): string {
  return redactString(value, [...sensitiveEnvValues(), ...additionalSecretValues]);
}

/**
 * Deep-redact an arbitrary value. Sensitive keys are replaced wholesale, while
 * every nested string is scrubbed against the supplied secret-value set.
 */
export function redact(value: unknown, secretValues: readonly string[] = sensitiveEnvValues()): unknown {
  if (typeof value === "string") return redactString(value, secretValues);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, secretValues));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isRedactedKey(k) ? "[redacted]" : redact(v, secretValues);
  }
  return out;
}

/** Collect sensitive values from decrypted account/agent configuration. */
export function collectSecretValues(value: unknown): string[] {
  const secrets = new Set<string>();

  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }

    const record = current as Record<string, unknown>;
    const namedKey = typeof record.key === "string"
      ? record.key
      : typeof record.name === "string"
        ? record.name
        : undefined;
    if (namedKey && isRedactedKey(namedKey) && typeof record.value === "string") {
      secrets.add(record.value);
    }

    for (const [key, nested] of Object.entries(record)) {
      const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
      if (["env", "envvars", "environmentvariables", "runtimevariables"].includes(normalizedKey)) {
        if (Array.isArray(nested)) {
          for (const entry of nested) {
            if (entry && typeof entry === "object" && typeof (entry as { value?: unknown }).value === "string") {
              secrets.add((entry as { value: string }).value);
            }
          }
        } else if (nested && typeof nested === "object") {
          for (const envValue of Object.values(nested as Record<string, unknown>)) {
            if (typeof envValue === "string") secrets.add(envValue);
          }
        }
      }
      if (isRedactedKey(key) && typeof nested === "string") secrets.add(nested);
      visit(nested);
    }
  };

  visit(value);
  return [...secrets].filter((secret) => secret.length >= 4);
}

const ENCODER = new TextEncoder();

function publishNats(
  level: "INFO" | "WARN" | "ERROR",
  entry: ObservabilityLogEntry,
): void {
  const connPromise = getObservabilityNatsConn();
  if (!connPromise) return;

  const ctx = getObservabilityContext();
  // Skip when the task isn't deployment-scoped (channel/cron paths have empty
  // project/env/endpoint): no dashboard tab subscribes those, so publishing to a
  // malformed subject is wasted. Durable OTLP + stdout still capture the line.
  if (!ctx || !ctx.endpointId || !ctx.project || !ctx.environment) return;

  const subject = logsSubject(ctx.accountId, ctx.project, ctx.environment, ctx.endpointId);

  connPromise
    .then((conn) => {
      conn.publish(subject, ENCODER.encode(JSON.stringify(entry)));
    })
    .catch(() => {
      // Best-effort; NATS hiccup must never lose durable (OTLP) data.
    });
}

function emit(
  level: "INFO" | "WARN" | "ERROR" | "DEBUG",
  message: string,
  data?: Record<string, unknown>,
): void {
  const ctx = getObservabilityContext();
  const ts = Date.now();
  const service = process.env.AWS_LAMBDA_FUNCTION_NAME ?? "filthy-panty-core";
  const secretValues = [...sensitiveEnvValues(), ...(ctx?.secretValues ?? [])];

  // Build the full structured entry, then redact the message and data payload.
  const redactedMessage = redactString(message, secretValues);
  const redactedData = data ? (redact(data, secretValues) as Record<string, unknown>) : undefined;
  const entry: Record<string, unknown> = {
    ...redactedData,
    time: new Date(ts).toISOString(),
    level,
    message: redactedMessage,
    service,
    "service.name": service,
    ...(ctx ? { traceId: ctx.traceId, accountId: ctx.accountId, endpointId: ctx.endpointId } : {}),
  };

  // 1. stdout — always, unmodified entry
  process.stdout.write(JSON.stringify(entry) + "\n");

  // 2. OTLP — best-effort; emitOtelLog never throws
  emitOtelLog(level, entry);

  // 3. NATS — INFO/WARN/ERROR only, context must be set
  if (level !== "DEBUG" && ctx) {
    const obsEntry: ObservabilityLogEntry = {
      ts,
      level: level as "INFO" | "WARN" | "ERROR",
      eventType: (redactedData?.eventType as string) ?? level.toLowerCase(),
      message: redactedMessage,
      traceId: ctx.traceId,
      accountId: ctx.accountId,
      endpointId: ctx.endpointId,
      service,
      agentId: ctx.agentId,
      conversationKey: ctx.conversationKey,
      data: redactedData,
    };
    publishNats(level as "INFO" | "WARN" | "ERROR", obsEntry);
  }
}

export function logDebug(message: string, data?: Record<string, unknown>): void {
  emit("DEBUG", message, data);
}

export function logInfo(message: string, data?: Record<string, unknown>): void {
  emit("INFO", message, data);
}

export function logWarn(message: string, data?: Record<string, unknown>): void {
  emit("WARN", message, data);
}

export function logError(message: string, data?: Record<string, unknown>): void {
  emit("ERROR", message, data);
}
