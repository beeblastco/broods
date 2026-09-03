/**
 * AWS Lambda entry for the sandbox log bridge. A CloudWatch subscription filter on
 * the per-stage MicroVM runtime log group invokes this with a gzipped batch of guest
 * stdout/stderr lines. Core names every VM's log stream
 * `<accountId>/<project>/<stage>/<uuid>` at launch, so the tenant labels Loki
 * indexes come from splitting the stream name: no lookup, no shared state. Lines
 * are redacted with the same string patterns core's log.ts applies, then posted as
 * one OTLP/HTTP request to the cluster collector, whose groupbyattrs processor
 * already routes them by tenant. Per-run secret values are unknown here, so only
 * the pattern half of core's redaction runs; the docs say so.
 */

import { gunzipSync } from "node:zlib";

const SERVICE_NAME = "broods-sandbox";
const PROVIDER = "lambda";
// A "-" segment means the run had no deployment scope (channel, cron). The line
// still ships for operators, but a "-" is not a tenant, so it is left unlabeled
// rather than indexed as one.
const UNSCOPED = "-";
const REQUEST_TIMEOUT_MS = 10_000;

// Same patterns as apps/core/src/shared/log.ts redactString; keep them in step.
const BEARER_SECRET_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const BASIC_SECRET_PATTERN = /\bBasic\s+[^\s,;]+/gi;
const QUERY_SECRET_PATTERN =
  /([?&](?:access_token|api_key|apikey|key|secret|token)=)[^&#\s]+/gi;
const RUNTIME_KEY_PATTERN = /\bfp_agent_[A-Za-z0-9_-]+\b/g;
const ROLE_SESSION_TOKEN_PATTERN = /\bfp_sts_[A-Za-z0-9_-]+\b/g;

/**
 * Lambda handler for one CloudWatch Logs subscription delivery. Control messages
 * (the filter's own health pings) and empty batches return without a request.
 */
export async function handler(event) {
  const payload = decodeCloudWatchEvent(event);
  if (payload.messageType !== "DATA_MESSAGE" || payload.logEvents.length === 0)
    return;

  const body = otlpLogsRequest(payload);
  const endpoint = requiredEnv("OTLP_ENDPOINT").replace(/\/+$/, "");
  const response = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${requiredEnv("OTLP_BASIC_AUTH")}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Throwing makes CloudWatch retry the delivery; a 4xx from the collector is a
    // config problem the retries will surface in this function's own log group.
    throw new Error(
      `OTLP push failed with HTTP ${response.status} for ${payload.logStream}`,
    );
  }
}

/**
 * Build the OTLP/HTTP JSON body for one batch. Tenant labels ride the resource so
 * the collector's groupbyattrs and Loki's index_label config pick them up; the
 * per-VM id is a log attribute so an ephemeral VM never becomes a new Loki stream.
 */
export function otlpLogsRequest(payload) {
  const { accountId, project, stage, sandboxId } = parseLogStream(
    payload.logStream,
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

/**
 * Split core's stream name into labels. A stream that does not follow the
 * `<accountId>/<project>/<stage>/<uuid>` shape (a VM launched by an older core)
 * keeps the whole name as its sandbox id and carries no tenant.
 */
export function parseLogStream(logStream) {
  const parts = logStream.split("/");
  if (parts.length !== 4) {
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

/** Pattern-only redaction, mirroring core's redactString without secret values. */
export function redact(line) {
  return line
    .replace(BEARER_SECRET_PATTERN, "Bearer [redacted]")
    .replace(BASIC_SECRET_PATTERN, "Basic [redacted]")
    .replace(QUERY_SECRET_PATTERN, "$1[redacted]")
    .replace(RUNTIME_KEY_PATTERN, "[redacted]")
    .replace(ROLE_SESSION_TOKEN_PATTERN, "[redacted]");
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
