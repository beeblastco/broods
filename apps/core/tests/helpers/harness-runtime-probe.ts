// Run as a script by ai-sdk-harness-runtime.test.ts: a process of its own keeps other test
// files' fakes of the harness packages out of these imports when bun runs without --isolate.

import type { HarnessV1BuiltinToolFiltering } from "@ai-sdk/harness";
import type { HarnessDebugConfig } from "@ai-sdk/harness/agent";
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
import { toErrorMessage } from "../../src/shared/errors.ts";

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
const OPENAI = {
  model: { provider: "openai", modelId: "gpt-5.1" },
  provider: { openai: { apiKey: "test-key" } },
} as const;
const CUSTOM = {
  model: { provider: "custom", modelId: "Qwen3.6-27B" },
  provider: {
    custom: { apiKey: "test-key", base_url: "https://llm.example.test/v1/" },
  },
} as const;

export type OutcomeName =
  | `${"workdir" | "microvm"}:${HarnessType}`
  | `custom:${"opencode" | "deepagents"}`
  | "codexAllowEdits"
  | "customCodex"
  | "openCodeFilters"
  | "openCodeInactive"
  | "codexDefault"
  | "openCodeExplicit"
  | "ephemeral";

// `settings` and `builtinToolFiltering` are private to HarnessAgent: read by name, untyped.
export interface RuntimeSummary {
  harnessId: string;
  bridgePort: number;
  bridgePorts?: ReadonlyArray<number>;
  reservationKey: string;
  versionedReservationKey: string;
  activeTools?: ReadonlyArray<string>;
  inactiveTools?: ReadonlyArray<string>;
  debug?: HarnessDebugConfig;
  builtinToolFiltering?: HarnessV1BuiltinToolFiltering;
}

export type Outcome = { runtime: RuntimeSummary } | { error: string };

function attempt(type: HarnessType, build: () => AiSdkHarnessRuntime): Outcome {
  try {
    const runtime = build();
    const settings = runtime.agent["settings"];

    return {
      runtime: {
        harnessId: runtime.agent.harnessId,
        bridgePort: runtime.bridgePort,
        bridgePorts: runtime.sandbox.bridgePorts,
        reservationKey: runtime.reservationKey,
        versionedReservationKey: `${RESERVATION}:${type}:${harnessAdapterVersion(type)}`,
        activeTools: settings.activeTools,
        inactiveTools: settings.inactiveTools,
        debug: settings.debug,
        builtinToolFiltering: runtime.agent["builtinToolFiltering"],
      },
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

function configured(
  harness: NonNullable<AgentConfig["harness"]>,
  config: Omit<AgentConfig, "harness">,
  extra: {
    compute?: ConfiguredHarnessAgentOptions["compute"];
    tools?: ToolSet;
  } = {},
): Outcome {
  return attempt(harness.type, () =>
    createConfiguredHarnessAgent({
      agentConfig: { ...config, harness: harness },
      compute: extra.compute ?? COMPUTE,
      instructions: "",
      reservationKey: RESERVATION,
      tools: extra.tools ?? {},
    }),
  );
}

const outcomes: Partial<Record<OutcomeName, Outcome>> = {
  codexAllowEdits: attempt("codex", () =>
    createWorkdirHarnessAgent({
      type: "codex",
      reservationKey: RESERVATION,
      compute: COMPUTE,
      permissionMode: "allow-edits",
    }),
  ),
  customCodex: configured(
    { type: "codex", permissionMode: "allow-all" },
    { ...CUSTOM, model: { ...CUSTOM.model, reasoning: "medium" } },
  ),
  openCodeFilters: configured(
    {
      type: "opencode",
      activeTools: ["bash", "custom_tool"],
      debug: { enabled: true, level: "trace", subsystems: ["bridge"] },
    },
    {
      ...OPENAI,
      denyTools: ["bash"],
      model: { ...OPENAI.model, reasoning: "high" },
    },
    {
      tools: {
        custom_tool: tool({
          description: "custom",
          inputSchema: jsonSchema({}),
        }),
      },
    },
  ),
  openCodeInactive: configured(
    { type: "opencode", inactiveTools: ["bash"] },
    OPENAI,
  ),
  codexDefault: configured(
    { type: "codex", permissionMode: "allow-all" },
    OPENAI,
  ),
  openCodeExplicit: configured(
    { type: "opencode", activeTools: ["bash", "askUserQuestions"] },
    OPENAI,
  ),
  "custom:opencode": configured({ type: "opencode" }, CUSTOM),
  "custom:deepagents": configured({ type: "deepagents" }, CUSTOM),
  ephemeral: configured(
    { type: "codex" },
    { ...OPENAI, model: { provider: "openai", modelId: "gpt-5" } },
    {
      compute: {
        provider: "vercel",
        persistent: false,
        network: { mode: "allow-all" },
      },
    },
  ),
};
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

process.stdout.write(JSON.stringify(outcomes));
