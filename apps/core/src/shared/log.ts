import type { ObservabilityLogEntry } from "../../../../packages/broods/src/observability-contracts.ts";
import {
  ensureObservabilityStream,
  getSharedNatsConn,
  logsSubject,
} from "./nats.ts";
import { isSecretName } from "@broods/convex/model/secretNames";
import { emitOtelLog, getObservabilityContext } from "./otel.ts";

const BEARER_SECRET_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const BASIC_SECRET_PATTERN = /\bBasic\s+[^\s,;]+/gi;
const QUERY_SECRET_PATTERN =
  /([?&](?:access_token|api_key|apikey|key|secret|token)=)[^&#\s]+/gi;
// This and the next pattern are copied in apps/lambda/sandbox-log-forwarder.mjs: keep in step.
const BROODS_CREDENTIAL_PATTERN =
  /(?=b)(?<=^|[^A-Za-z0-9_]|\\[nrt]|%[0-9A-Fa-f]{2})b(?:sk|ask|pdk|cli|code|sts|dts|rt)_[A-Za-z0-9_.-]{20,}/g;
// A JWT never starts inside a `-`/`_` run, so its own lookbehind keeps that branch linear.
const PROVIDER_CREDENTIAL_PATTERN =
  /(?=[gsAxey])(?:(?<=^|[^A-Za-z0-9]|\\[nrt]|%[0-9A-Fa-f]{2})(?:gh[oprsu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9_-]{32,}|A[KS]IA[A-Z0-9]{16}(?![A-Za-z0-9])|xox[abcdeoprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|ya29\.[A-Za-z0-9_-]{20,})|(?<=^|[^A-Za-z0-9_-]|\\[nrt]|%[0-9A-Fa-f]{2})eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
// Not every `*_NAME`: a SASL or SMTP user name is often a key.
const PUBLIC_ENV_NAME_PATTERN =
  /(?:^|[^a-z0-9])email$|^GIT_(?:AUTHOR|COMMITTER)_NAME$/i;
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
    const namedKey = entryName(record);
    if (
      namedKey &&
      isSecretName(namedKey) &&
      typeof record.value === "string"
    ) {
      secrets.add(record.value);
    }

    for (const [key, nested] of Object.entries(record)) {
      const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
      if (
        ["env", "envvars", "environmentvariables", "runtimevariables"].includes(
          normalizedKey,
        ) &&
        nested &&
        typeof nested === "object"
      ) {
        const entries: [string | undefined, unknown][] = Array.isArray(nested)
          ? nested.map((entry: unknown): [string | undefined, unknown] =>
              entry && typeof entry === "object" && "value" in entry
                ? [entryName(entry), entry.value]
                : [undefined, undefined],
            )
          : Object.entries(nested);
        for (const [envName, envValue] of entries) {
          if (
            typeof envValue === "string" &&
            (!envName ||
              isSecretName(envName) ||
              !PUBLIC_ENV_NAME_PATTERN.test(envName))
          ) {
            secrets.add(envValue);
          }
        }
      }
      if (isSecretName(key) && typeof nested === "string") secrets.add(nested);
      visit(nested);
    }
  };

  visit(value);

  return [...secrets].filter((secret) => secret.length >= 4);
}

export function redact(
  value: unknown,
  secretValues: readonly string[] = sensitiveEnvValues(),
): unknown {
  return redactValue(value, matchableSecrets(secretValues));
}

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
            isSecretName(key) ? "[redacted]" : item,
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
  // A secret can straddle a window's end, so its last `overlap` chars are never kept, and
  // it ends at whitespace so no pattern token is cut. It doubles if redaction shrank it.
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

// Unlike `redact`, keeps keys and skips the log patterns (`Bearer`, query tokens): this data is
// read back, so prose and a `nextPageToken` must arrive as they were.
export function redactWithRunSecrets(
  value: string,
  secretValues?: readonly string[],
): string;
export function redactWithRunSecrets(
  value: unknown,
  secretValues?: readonly string[],
): unknown;
export function redactWithRunSecrets(
  value: unknown,
  secretValues: readonly string[] = runSecretValues(),
): unknown {
  return redactRunValue(value, matchableSecrets(secretValues));
}

export function runSecretValues(): string[] {
  return [
    ...sensitiveEnvValues(),
    ...(getObservabilityContext()?.secretValues ?? []),
  ];
}

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
  const secretValues = runSecretValues();

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

function entryName(record: object): string | undefined {
  if ("key" in record && typeof record.key === "string") return record.key;

  return "name" in record && typeof record.name === "string"
    ? record.name
    : undefined;
}

function isSensitiveEnvName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");

  return (
    isSecretName(name) ||
    normalized.includes("credential") ||
    normalized.includes("authorization") ||
    normalized.endsWith("headers") ||
    normalized.endsWith("providerconfigjson") ||
    normalized.endsWith("toolsjson")
  );
}

// Longest first, so a secret inside another never leaves a tail.
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
  if (!ctx || !ctx.endpointId || !ctx.project || !ctx.stage) return;

  const subject = logsSubject(
    ctx.accountId,
    ctx.project,
    ctx.stage,
    ctx.endpointId,
  );

  connPromise
    .then(async (conn) => {
      await ensureObservabilityStream(conn).catch(() => {});
      conn.publish(subject, ENCODER.encode(JSON.stringify(entry)));
    })
    .catch(() => {});
}

function redactString(value: string, secretValues: readonly string[]): string {
  return scrubSecrets(value, matchableSecrets(secretValues));
}

function redactRunValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return replaceSecretValues(value, secrets);
  if (value === null || typeof value !== "object") return value;
  // What JSON.stringify would write: a Date is its ISO string, not `{}`.
  if ("toJSON" in value && typeof value.toJSON === "function") {
    return redactRunValue(value.toJSON(), secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactRunValue(item, secrets));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      redactRunValue(item, secrets),
    ]),
  );
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, secrets));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretName(k) ? "[redacted]" : redactValue(v, secrets);
  }

  return out;
}

function replaceSecretValues(
  value: string,
  secrets: readonly string[],
): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  redacted = redacted.replace(BROODS_CREDENTIAL_PATTERN, "[redacted]");

  return redacted;
}

function scrubSecrets(value: string, secrets: readonly string[]): string {
  let redacted = replaceSecretValues(value, secrets);
  redacted = redacted.replace(BEARER_SECRET_PATTERN, "Bearer [redacted]");
  redacted = redacted.replace(BASIC_SECRET_PATTERN, "Basic [redacted]");
  redacted = redacted.replace(QUERY_SECRET_PATTERN, "$1[redacted]");
  redacted = redacted.replace(PROVIDER_CREDENTIAL_PATTERN, "[redacted]");

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
