// Run as a script by ai-sdk-harness-runtime.test.ts: a process of its own keeps other test
// files' fakes of the harness packages out of these imports when bun runs without --isolate.
import { jsonSchema, tool, type ToolSet } from "ai";
import {
  createConfiguredHarnessAgent,
  createMicrovmHarnessAgent,
  createWorkdirHarnessAgent,
  harnessAdapterVersion,
  type AiSdkHarnessRuntime,
  type ConfiguredHarnessAgentOptions,
} from "../../src/harness/ai-sdk-harness/index.ts";
import type { AgentConfig } from "../../src/shared/domain/agent-config.ts";

const RESERVATION = "acct:agent:conversation";
const HARNESS_TYPES = [
  "claude-code",
  "codex",
  "deepagents",
  "opencode",
  "pi",
] as const;
type HarnessType = (typeof HARNESS_TYPES)[number];

const COMPUTE = {
  provider: "sandbox",
  persistent: true,
  network: { mode: "allow-all" },
  options: {
    workdirUrl: "https://workdir.example.test",
    apiKey: "test-key",
  },
} as const;

const MICROVM_COMPUTE = {
  provider: "lambda",
  persistent: true,
  network: { mode: "allow-all" },
  snapshot: "arn:aws:lambda:us-east-1:123456789012:microvm-image:harness-test",
} as const;

const CUSTOM_PROVIDER = {
  custom: { apiKey: "test-key", base_url: "https://llm.example.test/v1/" },
};
const OPENAI = { openai: { apiKey: "test-key" } };

export interface RuntimeSummary {
  harnessId: string;
  bridgePort: number;
  bridgePorts?: ReadonlyArray<number>;
  reservationKey: string;
  versionedReservationKey: string;
  activeTools?: ReadonlyArray<string>;
  inactiveTools?: ReadonlyArray<string>;
  debug?: unknown;
  builtinToolFiltering?: unknown;
}

export type Outcome = { runtime: RuntimeSummary } | { error: string };

function summarize(
  type: HarnessType,
  runtime: AiSdkHarnessRuntime,
): RuntimeSummary {
  const settings = runtime.agent["settings"];

  return {
    harnessId: runtime.agent.harnessId,
    bridgePort: runtime.bridgePort,
    bridgePorts: runtime.sandbox.bridgePorts,
    reservationKey: runtime.reservationKey,
    versionedReservationKey: `${RESERVATION}:${type}:${harnessAdapterVersion(type)}`,
    activeTools: settings.activeTools,
    inactiveTools: settings.inactiveTools,
    debug: settings.debug,
    builtinToolFiltering: runtime.agent["builtinToolFiltering"],
  };
}

function attempt(type: HarnessType, build: () => AiSdkHarnessRuntime): Outcome {
  try {
    return { runtime: summarize(type, build()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function configured(
  agentConfig: AgentConfig,
  compute: ConfiguredHarnessAgentOptions["compute"] = COMPUTE,
  tools: ToolSet = {},
): Outcome {
  return attempt(agentConfig.harness!.type, () =>
    createConfiguredHarnessAgent({
      agentConfig: agentConfig,
      compute: compute,
      instructions: "",
      reservationKey: RESERVATION,
      tools: tools,
    }),
  );
}

function probeHarnessRuntimes(): Record<string, Outcome> {
  const outcomes: Record<string, Outcome> = {};
  for (const type of HARNESS_TYPES) {
    outcomes[`workdir:${type}`] = attempt(type, () =>
      createWorkdirHarnessAgent({
        type: type,
        reservationKey: RESERVATION,
        compute: COMPUTE,
        bridgePort: 4567,
      }),
    );
    outcomes[`microvm:${type}`] = attempt(type, () =>
      createMicrovmHarnessAgent({
        type: type,
        reservationKey: RESERVATION,
        compute: MICROVM_COMPUTE,
        bridgePort: 4567,
      }),
    );
  }
  outcomes.codexAllowEdits = attempt("codex", () =>
    createWorkdirHarnessAgent({
      type: "codex",
      reservationKey: RESERVATION,
      compute: COMPUTE,
      permissionMode: "allow-edits",
    }),
  );
  outcomes.customCodex = configured({
    harness: { type: "codex", permissionMode: "allow-all" },
    model: { provider: "custom", modelId: "Qwen3.6-27B", reasoning: "medium" },
    provider: CUSTOM_PROVIDER,
  });
  outcomes.openCodeFilters = configured(
    {
      harness: {
        type: "opencode",
        activeTools: ["bash", "custom_tool"],
        debug: { enabled: true, level: "trace", subsystems: ["bridge"] },
      },
      denyTools: ["bash"],
      model: { provider: "openai", modelId: "gpt-5.1", reasoning: "high" },
      provider: OPENAI,
    },
    COMPUTE,
    {
      custom_tool: tool({ description: "custom", inputSchema: jsonSchema({}) }),
    },
  );
  const model = { provider: "openai", modelId: "gpt-5.1" } as const;
  outcomes.openCodeInactive = configured({
    harness: { type: "opencode", inactiveTools: ["bash"] },
    model: model,
    provider: OPENAI,
  });
  outcomes.codexDefault = configured({
    harness: { type: "codex", permissionMode: "allow-all" },
    model: model,
    provider: OPENAI,
  });
  outcomes.openCodeExplicit = configured({
    harness: { type: "opencode", activeTools: ["bash", "askUserQuestions"] },
    model: model,
    provider: OPENAI,
  });
  for (const type of ["opencode", "deepagents"] as const) {
    outcomes[`custom:${type}`] = configured({
      harness: { type: type },
      model: { provider: "custom", modelId: "Qwen3.6-27B" },
      provider: CUSTOM_PROVIDER,
    });
  }
  outcomes.ephemeral = configured(
    {
      harness: { type: "codex" },
      model: { provider: "openai", modelId: "gpt-5" },
      provider: OPENAI,
    },
    { provider: "vercel", persistent: false, network: { mode: "allow-all" } },
  );

  return outcomes;
}

if (import.meta.main)
  process.stdout.write(JSON.stringify(probeHarnessRuntimes()));
