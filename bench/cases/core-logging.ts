/**
 * Core's logging chokepoint. Every INFO/WARN/ERROR/DEBUG line in the agent
 * runtime is redacted here before it reaches stdout, OTLP and NATS, so this is
 * the most-executed CPU path in the pod.
 *
 * `process.env` is replaced with a fixed deployment-shaped fixture for the
 * duration of these cases. Without that the number would track whatever the CI
 * runner happens to export, and no baseline would ever hold.
 */

import {
  collectSecretValues,
  redact,
  redactSensitiveText,
} from "../../apps/core/src/shared/log.ts";
import type { BenchCase } from "../runner.ts";

// A deployed core pod's environment, trimmed to the shape that matters: a few
// dozen names, several sensitive, and two large JSON values the redactor parses.
const ENV_FIXTURE: Readonly<Record<string, string>> = {
  ADMIN_ACCOUNT_SECRET: "fp_admin_9d2f41ba7c3e5089bd6a",
  AGENT_TABLE_NAME: "broods-dev-agents",
  ANTHROPIC_API_KEY: "sk-ant-api03-8f2c1d9e4b7a6350c8e1f0a2d3b4c5e6",
  AWS_REGION: "us-east-1",
  CONVEX_URL: "https://vivid-marten-412.convex.cloud",
  GATEWAY_BASE_URL: "https://gateway.broods.app",
  NATS_TOKEN: "nt_4b18c07d92ae5361f8b0",
  NATS_URL: "nats://nats.broods.svc.cluster.local:4222",
  OPENAI_API_KEY: "sk-proj-1a2b3c4d5e6f708192a3b4c5d6e7f809",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://alloy.observability.svc:4318",
  PROVIDER_CONFIG_JSON: JSON.stringify({
    anthropic: {
      apiKey: "sk-ant-api03-fixture-1122334455667788990011223344",
      baseURL: "https://api.anthropic.com",
      headers: { "anthropic-beta": "prompt-caching-2024-07-31" },
    },
    openai: {
      apiKey: "sk-proj-fixture-99887766554433221100",
      organization: "org-fixture-4152",
    },
    bedrock: {
      accessKeyId: "AKIAFIXTURE0000EXAMPLE",
      secretAccessKey: "wJalrFIXTUREKEY/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    },
  }),
  SANDBOX_PROVIDER: "lambda",
  SERVICE_AUTH_SECRET: "fp_svc_71c9e3a08d54b2f6",
  SERVICE_NAME: "broods-core",
  STAGE: "production",
  TOOL_BUNDLES_BUCKET_NAME: "broods-prod-tool-bundles",
  TOOLS_JSON: JSON.stringify({
    slack: { botToken: "xoxb-fixture-1029384756-abcdefghij" },
    github: { appId: "884412", privateKey: "-----BEGIN RSA PRIVATE KEY-----" },
    linear: { apiKey: "lin_api_fixture_5a6b7c8d9e0f" },
  }),
  WORKSPACE_BUCKET_NAME: "broods-prod-workspaces",
};

// A representative structured log payload: an agent turn completing, with the
// nesting and the sensitive-key mix real entries carry.
const LOG_PAYLOAD: Readonly<Record<string, unknown>> = {
  eventType: "agent.turn.completed",
  accountId: "acc_5f21c9",
  agentId: "agt_7f3c9d21",
  conversationKey: "slack:T04ABCD:C09XYZ:1725400000.123456",
  durationMs: 4182,
  model: { provider: "anthropic", id: "claude-opus-5", temperature: 0.2 },
  usage: {
    inputTokens: 18_204,
    outputTokens: 1_431,
    cachedInputTokens: 16_000,
    totalTokens: 19_635,
  },
  request: {
    method: "POST",
    url: "https://gateway.broods.app/v1/agents/agt_7f3c9d21/invoke?api_key=abcd1234",
    headers: {
      authorization: "Bearer fp_agent_1a2b3c4d5e6f7g8h",
      "x-api-key": "sk-proj-fixture-99887766554433221100",
      "content-type": "application/json",
    },
  },
  tools: [
    { name: "bash", calls: 3, ok: true },
    { name: "read", calls: 7, ok: true },
    { name: "slack_post", calls: 1, ok: false, error: "channel_not_found" },
  ],
};

// A free-form line of the kind provider errors and tool stderr produce.
const LOG_LINE =
  "provider call failed for agent agt_7f3c9d21: POST https://api.anthropic.com/v1/messages " +
  "with Authorization: Bearer sk-ant-api03-8f2c1d9e4b7a6350c8e1f0a2d3b4c5e6 " +
  "(runtime key fp_agent_1a2b3c4d5e6f7g8h) returned 529 overloaded_error after 3 retries";

// The decrypted agent record the runtime scans once per run to learn which
// values must never reach a log line.
const AGENT_RECORD: Readonly<Record<string, unknown>> = {
  agentId: "agt_7f3c9d21",
  model: { provider: "anthropic", id: "claude-opus-5" },
  env: {
    LINEAR_API_KEY: "lin_api_fixture_5a6b7c8d9e0f",
    STRIPE_SECRET_KEY: "sk_live_fixture_112233445566",
    PUBLIC_BASE_URL: "https://acme.example.com",
  },
  mcp: [
    {
      id: "mcp_notion",
      transport: "http",
      url: "https://mcp.notion.com/sse",
      headers: { authorization: "Bearer ntn_fixture_99887766" },
    },
    {
      id: "mcp_github",
      transport: "stdio",
      env: [{ key: "GITHUB_TOKEN", value: "ghp_fixture_5544332211" }],
    },
  ],
  channels: [
    { kind: "slack", botToken: "xoxb-fixture-1029384756-abcdefghij" },
    { kind: "discord", token: "MTIz.fixture.AbCdEfGhIjKlMnOp" },
  ],
};

export const coreLoggingCases: readonly BenchCase[] = [
  {
    name: "core/log-redact-payload",
    iterations: 1_000,
    setup: installEnvFixture,
    teardown: restoreEnv,
    // The redaction itself, with the secret set already in hand: what an
    // emit() would cost if the env scan were hoisted out of the per-line path.
    run: (): unknown => redact(LOG_PAYLOAD, PRECOMPUTED_SECRETS),
  },
  {
    name: "core/log-redact-text-with-env-scan",
    iterations: 400,
    setup: installEnvFixture,
    teardown: restoreEnv,
    // What a line costs today: the env walk, the JSON parses and the scrub,
    // all of it repeated per line. Compare against log-redact-payload.
    run: (): unknown => redactSensitiveText(LOG_LINE),
  },
  {
    name: "core/log-redact-text-precomputed",
    iterations: 20_000,
    setup: installEnvFixture,
    teardown: restoreEnv,
    // The same line scrubbed against a secret set that was already collected.
    // `redact` on a string is the scrub with nothing else attached, so the gap
    // between this and log-redact-text-with-env-scan is exactly what re-deriving
    // the env secrets costs on every single log line.
    run: (): unknown => redact(LOG_LINE, PRECOMPUTED_SECRETS),
  },
  {
    name: "core/log-collect-secret-values",
    iterations: 2_000,
    setup: installEnvFixture,
    teardown: restoreEnv,
    run: (): unknown => collectSecretValues(AGENT_RECORD),
  },
];

// Collected once from the fixture so the pure-redaction case is not charged for
// the scan the other case exists to measure.
const PRECOMPUTED_SECRETS: readonly string[] = [
  "sk-ant-api03-8f2c1d9e4b7a6350c8e1f0a2d3b4c5e6",
  "sk-proj-1a2b3c4d5e6f708192a3b4c5d6e7f809",
  "sk-proj-fixture-99887766554433221100",
  "fp_admin_9d2f41ba7c3e5089bd6a",
  "fp_svc_71c9e3a08d54b2f6",
  "nt_4b18c07d92ae5361f8b0",
  "xoxb-fixture-1029384756-abcdefghij",
  "lin_api_fixture_5a6b7c8d9e0f",
];

let savedEnv: Record<string, string | undefined> | null = null;

function installEnvFixture(): void {
  if (savedEnv) return;
  savedEnv = { ...process.env };
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, ENV_FIXTURE);
}

function restoreEnv(): void {
  if (!savedEnv) return;
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  savedEnv = null;
}
