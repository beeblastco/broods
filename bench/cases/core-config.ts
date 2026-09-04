/**
 * What core does to an agent's configuration on every run before the model is
 * reached: decrypt the stored blob, validate and normalize the shape, and
 * resolve `${NAME}` references against the account's environment. The config
 * plane runs the same substitution at sync time, so the last case is also
 * what `broods dev` costs per agent to inject env.
 */

import {
  decodeStoredAgentConfig,
  encryptAgentConfig,
  normalizeAgentConfig,
} from "../../apps/core/src/shared/domain/agent-config.ts";
import { envCodec } from "../../packages/convex/bench/harness.ts";
import type { BenchCase } from "../runner.ts";

const ENCRYPTION_SECRET = "bench-only-account-config-secret-0000";

// An agent the way a real project defines one: a custom provider with env
// refs, session tuning, a channel, hooks and a few tools. Wide enough that
// every normalizer branch runs.
const RAW_CONFIG: Readonly<Record<string, unknown>> = {
  agent: {
    system:
      "You are the on-call assistant for the payments team. Be brief, cite the runbook section you used, and never run a destructive command without approval.",
    maxTurn: 12,
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
    temperature: 0.2,
    maxOutputTokens: 4096,
    providerOptions: { custom: { reasoningEffort: "low" } },
  },
  provider: {
    custom: {
      apiKey: "sk-fixture-1a2b3c4d5e6f708192a3b4c5d6e7f809",
      base_url: "https://inference.example.com/v1",
      headers: { "x-org": "org_4152" },
    },
  },
  session: {
    pruning: { enabled: true },
    compaction: { enabled: true, maxContextLength: 80_000 },
  },
  channels: {
    slack: {
      id: "slack-payments",
      botToken: "xoxb-fixture-1029384756-abcdefghij",
      signingSecret: "sig-fixture-5544332211",
    },
  },
  tools: {
    googleSearch: { enabled: true },
  },
  publicAccess: true,
};

// The same agent as the config plane holds it: env refs unresolved. Core only
// ever sees the substituted form, so this one never goes through normalize.
const PLACEHOLDER_CONFIG: Readonly<Record<string, unknown>> = {
  ...RAW_CONFIG,
  provider: {
    custom: {
      apiKey: "${AI_API_KEY}",
      base_url: "${AI_BASE_URL}",
      headers: { "x-org": "${ORG_ID}" },
    },
  },
  channels: {
    slack: {
      id: "slack-payments",
      botToken: "${SLACK_BOT_TOKEN}",
      signingSecret: "${SLACK_SIGNING_SECRET}",
    },
  },
};

const ACCOUNT_ENV: Readonly<Record<string, string>> = {
  AI_API_KEY: "sk-fixture-1a2b3c4d5e6f708192a3b4c5d6e7f809",
  AI_BASE_URL: "https://inference.example.com/v1",
  ORG_ID: "org_4152",
  SLACK_BOT_TOKEN: "xoxb-fixture-1029384756-abcdefghij",
  SLACK_SIGNING_SECRET: "sig-fixture-5544332211",
  UNUSED_ONE: "value",
  UNUSED_TWO: "value",
};

export const coreConfigCases: readonly BenchCase[] = [
  {
    name: "core/config-normalize",
    iterations: 5_000,
    run: (): unknown => normalizeAgentConfig(RAW_CONFIG),
  },
  {
    name: "core/config-encrypt-decrypt",
    iterations: 5_000,
    setup: (): void => {
      savedSecret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
      process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = ENCRYPTION_SECRET;
    },
    teardown: (): void => {
      if (savedSecret === undefined)
        delete process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
      else process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = savedSecret;
    },
    // Write then read, the round trip an agent record makes through storage.
    run: (): unknown =>
      decodeStoredAgentConfig(encryptAgentConfig(NORMALIZED_CONFIG)),
  },
  {
    name: "core/config-env-inject",
    iterations: 5_000,
    run: (): unknown => {
      const names = envCodec.collectEnvPlaceholderNames(PLACEHOLDER_CONFIG);

      return [
        names.size,
        envCodec.substituteAccountEnvPlaceholders(
          PLACEHOLDER_CONFIG,
          ACCOUNT_ENV,
        ),
      ];
    },
  },
];

const NORMALIZED_CONFIG = normalizeAgentConfig(RAW_CONFIG);
let savedSecret: string | undefined;
