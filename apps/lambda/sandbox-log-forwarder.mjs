// Tenant labels come only from a stream name core signed at launch,
// `<accountId>/<project>/<stage>/<uuid>/<mac>`: a guest can create any stream in the group.

import { createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";

const SERVICE_NAME = "broods-sandbox";
const PROVIDER = "lambda";
// Keep in step with core's microvm-executor.
const LOG_STREAM_MAC_LENGTH = 16;
const UNSCOPED = "-";
const REQUEST_TIMEOUT_MS = 10_000;

// Mirrors redactString in apps/core/src/shared/log.ts, keep in step. Per-run secret values
// are unknown here, so only the patterns run.
const BEARER_SECRET_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const BASIC_SECRET_PATTERN = /\bBasic\s+[^\s,;]+/gi;
const QUERY_SECRET_PATTERN =
  /([?&](?:access_token|api_key|apikey|key|secret|token)=)[^&#\s]+/gi;
const BROODS_CREDENTIAL_PATTERN =
  /(?=b)(?<=^|[^A-Za-z0-9_]|\\[nrt]|%[0-9A-Fa-f]{2})b(?:sk|ask|pdk|cli|code|sts|dts|rt)_[A-Za-z0-9_.-]{20,}/g;
const PROVIDER_CREDENTIAL_PATTERN =
  /(?=[gsAxey])(?:(?<=^|[^A-Za-z0-9]|\\[nrt]|%[0-9A-Fa-f]{2})(?:gh[oprsu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9_-]{32,}|A[KS]IA[A-Z0-9]{16}(?![A-Za-z0-9])|xox[abcdeoprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|ya29\.[A-Za-z0-9_-]{20,})|(?<=^|[^A-Za-z0-9_-]|\\[nrt]|%[0-9A-Fa-f]{2})eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

export async function handler(event) {
  const payload = decodeCloudWatchEvent(event);
  if (payload.messageType !== "DATA_MESSAGE" || payload.logEvents.length === 0)
    return;

  const otlpAuth = requiredEnv("OTEL_EXPORTER_OTLP_HEADERS");
  const body = otlpLogsRequest(payload, otlpAuth);
  const endpoint = requiredEnv("OTEL_EXPORTER_OTLP_ENDPOINT").replace(
    /\/+$/,
    "",
  );
  const response = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers: {
      ...otlpHeaders(otlpAuth),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Throwing makes CloudWatch retry the delivery.
    throw new Error(
      `OTLP push failed with HTTP ${response.status} for ${payload.logStream}`,
    );
  }
}

export function otlpHeaders(raw) {
  const headers = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }

  return headers;
}

// The per-VM id is a record attribute: on the resource, every ephemeral VM is a new Loki stream.
export function otlpLogsRequest(payload, key) {
  const { accountId, project, stage, sandboxId } = parseLogStream(
    payload.logStream,
    key,
  );
  const resource = {
    "service.name": SERVICE_NAME,
    ...(accountId ? { account_id: accountId } : {}),
    ...(project ? { project: project } : {}),
    ...(stage ? { stage: stage } : {}),
  };
  const logRecords = payload.logEvents.map((event) => ({
    timeUnixNano: String(BigInt(event.timestamp) * 1_000_000n),
    severityText: "INFO",
    body: { stringValue: redact(event.message) },
    attributes: otlpAttributes({
      sandbox_id: sandboxId,
      source: "sandbox",
      provider: PROVIDER,
      "aws.cloudwatch.log_group": payload.logGroup,
      "aws.cloudwatch.log_stream": payload.logStream,
    }),
  }));

  return {
    resourceLogs: [
      {
        resource: { attributes: otlpAttributes(resource) },
        scopeLogs: [{ scope: { name: SERVICE_NAME }, logRecords: logRecords }],
      },
    ],
  };
}

export function parseLogStream(logStream, key) {
  const parts = logStream.split("/");
  if (parts.length !== 5 || !verifyLogStream(parts, key)) {
    return {
      accountId: undefined,
      project: undefined,
      stage: undefined,
      sandboxId: logStream,
    };
  }
  const [accountId, project, stage, sandboxId] = parts;

  return {
    accountId: scoped(accountId),
    project: scoped(project),
    stage: scoped(stage),
    sandboxId: sandboxId,
  };
}

export function redact(line) {
  return line
    .replace(BEARER_SECRET_PATTERN, "Bearer [redacted]")
    .replace(BASIC_SECRET_PATTERN, "Basic [redacted]")
    .replace(QUERY_SECRET_PATTERN, "$1[redacted]")
    .replace(BROODS_CREDENTIAL_PATTERN, "[redacted]")
    .replace(PROVIDER_CREDENTIAL_PATTERN, "[redacted]");
}

function decodeCloudWatchEvent(event) {
  const raw = gunzipSync(Buffer.from(event.awslogs.data, "base64"));

  return JSON.parse(raw.toString("utf8"));
}

function otlpAttributes(record) {
  return Object.entries(record).map(([key, value]) => ({
    key: key,
    value: { stringValue: value },
  }));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);

  return value;
}

function scoped(segment) {
  return segment === UNSCOPED || segment === "" ? undefined : segment;
}

function verifyLogStream(parts, key) {
  const expected = Buffer.from(
    createHmac("sha256", key)
      .update(parts.slice(0, 4).join("/"))
      .digest("hex")
      .slice(0, LOG_STREAM_MAC_LENGTH),
  );
  const given = Buffer.from(parts[4]);

  return given.length === expected.length && timingSafeEqual(given, expected);
}
