/**
 * Shared logging helpers. This module redacts every line at the single chokepoint,
 * then emits it in order: stdout (CloudWatch fallback, all levels), OTLP
 * (best-effort, all levels), and NATS (INFO/WARN/ERROR only, requires an
 * observability context from setObservabilityContext()).
 */

import type { ObservabilityLogEntry } from "../../../../packages/broods/src/observability-contracts.ts";
import {
  ensureObservabilityStream,
  getSharedNatsConn,
  logsSubject,
} from "./nats.ts";
import { emitOtelLog, getObservabilityContext } from "./otel.ts";

// Keys are matched after normalizing to lowercase with hyphens/underscores
// stripped, against three lists: exact, prefix, and suffix.
const DENY_EXACT: ReadonlySet<string> = new Set([
  "authorization",
  "xapikey", // x-api-key / x_api_key
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

const BEARER_SECRET_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const BASIC_SECRET_PATTERN = /\bBasic\s+[^\s,;]+/gi;
const QUERY_SECRET_PATTERN =
  /([?&](?:access_token|api_key|apikey|key|secret|token)=)[^&#\s]+/gi;
// Every Broods credential: its b-prefix plus a long base64url body (signed
// tickets add a dot), so short identifiers like `bsk_id` stay readable.
// Identical in apps/lambda/sandbox-log-forwarder.mjs; keep them in step.
const BROODS_CREDENTIAL_PATTERN =
  /\bb(?:sk|ask|pdk|cli|code|sts|dts|rt)_[A-Za-z0-9_.-]{20,}/g;
const WHITESPACE_PATTERN = /\s/g;

const ENCODER = new TextEncoder();

export function collectSecretValues(value: unknown): string[] {
  const secrets = new Set<string>();

  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach(visit);

      return;
    }

    const record = current as Record<string, unknown>;
    const namedKey =
      typeof record.key === "string"
        ? record.key
        : typeof record.name === "string"
          ? record.name
          : undefined;
    if (
      namedKey &&
      isRedactedKey(namedKey) &&
      typeof record.value === "string"
    ) {
      secrets.add(record.value);
    }

    for (const [key, nested] of Object.entries(record)) {
      const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
      if (
        ["env", "envvars", "environmentvariables", "runtimevariables"].includes(
          normalizedKey,
        )
      ) {
        if (Array.isArray(nested)) {
          for (const entry of nested) {
            if (
              entry &&
              typeof entry === "object" &&
              typeof (entry as { value?: unknown }).value === "string"
            ) {
              secrets.add((entry as { value: string }).value);
            }
          }
        } else if (nested && typeof nested === "object") {
          for (const envValue of Object.values(
            nested as Record<string, unknown>,
          )) {
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

/**
 * Deep-redact an arbitrary value. Sensitive keys are replaced wholesale, while
 * every nested string is scrubbed against the supplied secret-value set.
 */
export function redact(
  value: unknown,
  secretValues: readonly string[] = sensitiveEnvValues(),
): unknown {
  return redactValue(value, matchableSecrets(secretValues));
}

/**
 * Serializes a value for a span attribute with sensitive keys and secrets
 * redacted, cut to `maxChars`. Only the kept prefix is scrubbed, so a long
 * history costs one `JSON.stringify` instead of a deep redact.
 */
export function redactSerialized(
  value: unknown,
  secretValues: readonly string[],
  maxChars: number,
): string {
  let text: string;
  try {
    text =
      typeof value === "string"
        ? value
        : (JSON.stringify(value, (key: string, item: unknown): unknown =>
            isRedactedKey(key) ? "[redacted]" : item,
          ) ?? "");
  } catch {
    text = String(value);
  }
  // Inside JSON a secret appears escaped, so match that form too.
  const secrets = matchableSecrets(
    secretValues.flatMap((secret): string[] => [
      secret,
      JSON.stringify(secret).slice(1, -1),
    ]),
  );
  // A secret can straddle a window's end, so the last `overlap` chars of a
  // scrubbed window are never kept, and a window ends at whitespace so it
  // never cuts a token the patterns match. The window grows when replacements
  // shrank it below `maxChars`.
  const overlap = secrets[0]?.length ?? 0;
  for (let size = maxChars + overlap; ; size *= 2) {
    WHITESPACE_PATTERN.lastIndex = size;
    const end = WHITESPACE_PATTERN.exec(text)?.index ?? text.length;
    if (end >= text.length) {
      const scrubbed = scrubSecrets(text, secrets);

      return scrubbed.length <= maxChars
        ? scrubbed
        : `${scrubbed.slice(0, maxChars)}...[truncated]`;
    }
    const scrubbed = scrubSecrets(text.slice(0, end), secrets);
    const kept = scrubbed.slice(0, scrubbed.length - overlap);
    if (kept.length >= maxChars) {
      return `${kept.slice(0, maxChars)}...[truncated]`;
    }
  }
}

/** Redact a free-form string using sensitive env values plus task-local secrets. */
export function redactSensitiveText(
  value: string,
  additionalSecretValues: readonly string[] = [],
): string {
  return redactString(value, [
    ...sensitiveEnvValues(),
    ...additionalSecretValues,
  ]);
}

export function logDebug(
  message: string,
  data?: Record<string, unknown>,
): void {
  emit("DEBUG", message, data);
}

export function logError(
  message: string,
  data?: Record<string, unknown>,
): void {
  emit("ERROR", message, data);
}

export function logInfo(message: string, data?: Record<string, unknown>): void {
  emit("INFO", message, data);
}

export function logWarn(message: string, data?: Record<string, unknown>): void {
  emit("WARN", message, data);
}

function emit(
  level: "INFO" | "WARN" | "ERROR" | "DEBUG",
  message: string,
  data?: Record<string, unknown>,
): void {
  const ctx = getObservabilityContext();
  const ts = Date.now();
  const service = process.env.SERVICE_NAME ?? "broods-core";
  const secretValues = [...sensitiveEnvValues(), ...(ctx?.secretValues ?? [])];

  const redactedMessage = redactString(message, secretValues);
  const redactedData = data
    ? (redact(data, secretValues) as Record<string, unknown>)
    : undefined;
  const entry: Record<string, unknown> = {
    ...redactedData,
    time: new Date(ts).toISOString(),
    level: level,
    message: redactedMessage,
    service: service,
    "service.name": service,
    ...(ctx
      ? {
          traceId: ctx.traceId,
          accountId: ctx.accountId,
          endpointId: ctx.endpointId,
        }
      : {}),
  };

  process.stdout.write(JSON.stringify(entry) + "\n");

  emitOtelLog(level, entry);

  if (level !== "DEBUG" && ctx) {
    const obsEntry: ObservabilityLogEntry = {
      ts: ts,
      level: level as "INFO" | "WARN" | "ERROR",
      eventType: (redactedData?.eventType as string) ?? level.toLowerCase(),
      message: redactedMessage,
      traceId: ctx.traceId,
      accountId: ctx.accountId,
      endpointId: ctx.endpointId,
      service: service,
      agentId: ctx.agentId,
      conversationKey: ctx.conversationKey,
      data: redactedData,
    };
    publishNats(level as "INFO" | "WARN" | "ERROR", obsEntry);
  }
}

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

function isSensitiveEnvName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-_]/g, "");

  return (
    isRedactedKey(name) ||
    normalized.includes("credential") ||
    normalized.includes("authorization") ||
    normalized.endsWith("headers") ||
    normalized.endsWith("providerconfigjson") ||
    normalized.endsWith("toolsjson")
  );
}

/** Secrets long enough to match, longest first so one inside another never leaves a tail. */
function matchableSecrets(secretValues: readonly string[]): string[] {
  return [...new Set(secretValues.filter((secret) => secret.length >= 4))].sort(
    (left, right) => right.length - left.length,
  );
}

function publishNats(
  level: "INFO" | "WARN" | "ERROR",
  entry: ObservabilityLogEntry,
): void {
  const connPromise = getSharedNatsConn();
  if (!connPromise) return;

  const ctx = getObservabilityContext();
  // Skip when the task isn't deployment-scoped (channel/cron paths have empty
  // project/stage/endpoint): no dashboard tab subscribes those, so publishing
  // to a malformed subject is wasted. Durable OTLP + stdout still capture it.
  if (!ctx || !ctx.endpointId || !ctx.project || !ctx.stage) return;

  const subject = logsSubject(
    ctx.accountId,
    ctx.project,
    ctx.stage,
    ctx.endpointId,
  );

  connPromise
    .then(async (conn) => {
      // Ensure the durable stream captures this line for dashboard replay;
      // memoized, so ~free after the first call. Live publish proceeds regardless.
      await ensureObservabilityStream(conn).catch(() => {});
      conn.publish(subject, ENCODER.encode(JSON.stringify(entry)));
    })
    .catch(() => {
      // Best-effort; NATS hiccup must never lose durable (OTLP) data.
    });
}

function redactString(value: string, secretValues: readonly string[]): string {
  return scrubSecrets(value, matchableSecrets(secretValues));
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, secrets));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isRedactedKey(k) ? "[redacted]" : redactValue(v, secrets);
  }

  return out;
}

/** Replaces each secret (already from `matchableSecrets`) and every known token shape. */
function scrubSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  redacted = redacted.replace(BEARER_SECRET_PATTERN, "Bearer [redacted]");
  redacted = redacted.replace(BASIC_SECRET_PATTERN, "Basic [redacted]");
  redacted = redacted.replace(QUERY_SECRET_PATTERN, "$1[redacted]");
  redacted = redacted.replace(BROODS_CREDENTIAL_PATTERN, "[redacted]");

  return redacted;
}

function sensitiveEnvValues(): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || !isSensitiveEnvName(name)) continue;
    if (value.length >= 4) values.push(value);
    const authValue = value.match(/\b(?:Basic|Bearer)\s+([^,\s]+)/i)?.[1];
    if (authValue && authValue.length >= 4) values.push(authValue);
    if (
      value.trimStart().startsWith("{") ||
      value.trimStart().startsWith("[")
    ) {
      try {
        values.push(...collectSecretValues(JSON.parse(value)));
      } catch {
        // Invalid JSON is still redacted as one opaque value above.
      }
    }
  }

  return values;
}
