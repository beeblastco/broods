import {
  collectSecretValues,
  redact,
  redactSensitiveText,
} from "../../apps/core/src/shared/log.ts";
import type { BenchCase } from "../runner.ts";

// Replaces process.env during these cases, or the number tracks whatever the CI runner exports.
const ENV_FIXTURE: Readonly<Record<string, string>> = {
  ADMIN_ACCOUNT_SECRET: "admin-secret-9d2f41ba7c3e5089bd6a",
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
  SERVICE_AUTH_SECRET: "service-secret-71c9e3a08d54b2f6",
  SERVICE_NAME: "broods-core",
  STAGE: "production",
  TOOL_BUNDLES_BUCKET_NAME: "broods-prod-tool-bundles",
  TOOLS_JSON: JSON.stringify({
    slack: { botToken: "xoxb-fixture-1029384756-abcdefghij" },
    github: {
      appId: "884412",
      privateKey: "test-only-private-key-placeholder",
    },
    linear: { apiKey: "lin_api_fixture_5a6b7c8d9e0f" },
  }),
  WORKSPACE_BUCKET_NAME: "broods-prod-workspaces",
};

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
      authorization: "Bearer bsk_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p",
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

const LOG_LINE =
  "provider call failed for agent agt_7f3c9d21: POST https://api.anthropic.com/v1/messages " +
  "with Authorization: Bearer sk-ant-api03-8f2c1d9e4b7a6350c8e1f0a2d3b4c5e6 " +
  "(runtime key bsk_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p) returned 529 overloaded_error after 3 retries";

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
    run: (): unknown => redact(LOG_PAYLOAD, PRECOMPUTED_SECRETS),
  },
  {
    name: "core/log-redact-text-with-env-scan",
    iterations: 400,
    setup: installEnvFixture,
    teardown: restoreEnv,
    run: (): unknown => redactSensitiveText(LOG_LINE),
  },
  {
    name: "core/log-redact-text-precomputed",
    iterations: 20_000,
    setup: installEnvFixture,
    teardown: restoreEnv,
    // The gap to log-redact-text-with-env-scan is what re-deriving env secrets costs per line.
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

const PRECOMPUTED_SECRETS: readonly string[] = [
  "sk-ant-api03-8f2c1d9e4b7a6350c8e1f0a2d3b4c5e6",
  "sk-proj-1a2b3c4d5e6f708192a3b4c5d6e7f809",
  "sk-proj-fixture-99887766554433221100",
  "admin-secret-9d2f41ba7c3e5089bd6a",
  "service-secret-71c9e3a08d54b2f6",
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
