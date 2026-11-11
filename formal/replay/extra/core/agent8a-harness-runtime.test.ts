import { describe, expect, mock, test } from "bun:test";
import type { ToolSet } from "ai";

import { loadConfiguredHarnessSkills } from "../../../../apps/core/src/harness/skills.ts";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";

// The vendor package is a dependency of apps/core, so it resolves from there.
const AGENT_MODULE = Bun.resolveSync(
  "@ai-sdk/harness/agent",
  `${import.meta.dir}/../../../../apps/core/src`,
);
const realAgentModule = (await import(
  AGENT_MODULE
)) as typeof import("../../../../apps/core/node_modules/@ai-sdk/harness/dist/agent/index.js");
const built: Record<string, unknown>[] = [];

class FakeHarnessAgent {
  constructor(settings: Record<string, unknown>) {
    built.push(settings);
  }
}

// Replaced at the boundary so the settings handed to the vendor class can be read back.
void mock.module(AGENT_MODULE, (): typeof realAgentModule => ({
  ...realAgentModule,
  HarnessAgent:
    FakeHarnessAgent as unknown as typeof realAgentModule.HarnessAgent,
}));

const ADAPTERS = `${import.meta.dir}/../../../../apps/core/src/harness/ai-sdk-harness/adapters/index.ts`;
const realAdapters = (await import(
  ADAPTERS
)) as typeof import("../../../../apps/core/src/harness/ai-sdk-harness/adapters/index.ts");

// Real adapters carry zod schemas the recorder cannot read, voiding every call holding one.
function plainAdapter(type: string): unknown {
  return {
    harnessId: type,
    builtinTools: {
      read: { description: "Read" },
      ...(type === "opencode"
        ? { askUserQuestions: { description: "Ask" } }
        : {}),
    },
  };
}

void mock.module(ADAPTERS, (): typeof realAdapters => ({
  ...realAdapters,
  createAiSdkHarnessAdapter: ((type: string): unknown =>
    plainAdapter(
      type,
    )) as unknown as typeof realAdapters.createAiSdkHarnessAdapter,
  createConfiguredAiSdkHarnessAdapter: ((config: {
    harness: { type: string };
  }): unknown =>
    plainAdapter(
      config.harness.type,
    )) as unknown as typeof realAdapters.createConfiguredAiSdkHarnessAdapter,
}));

const runtime =
  await import("../../../../apps/core/src/harness/ai-sdk-harness/runtime.ts");

// Called bare: through the namespace object the recorder would see it as the receiver.
const {
  createConfiguredHarnessAgent,
  createMicrovmHarnessAgent,
  createWorkdirHarnessAgent,
} = runtime;

type ConfiguredOptions = Parameters<
  typeof runtime.createConfiguredHarnessAgent
>[0];
type WorkdirOptions = Parameters<typeof runtime.createWorkdirHarnessAgent>[0];
type MicrovmOptions = Parameters<typeof runtime.createMicrovmHarnessAgent>[0];

interface HarnessShape {
  type: string;
  activeTools?: string[];
  inactiveTools?: string[];
  permissionMode?: string;
}

const WORKDIR_COMPUTE = {
  provider: "sandbox",
  persistent: true,
  onCreate: ["echo ready"],
  options: { workdirUrl: "https://workdir.example.com", apiKey: "test-key" },
} as unknown as WorkdirOptions["compute"];
const MICROVM_COMPUTE = {
  provider: "lambda",
  persistent: true,
} as unknown as MicrovmOptions["compute"];
const TOOLS = { read: {}, custom: {}, shell: {} } as unknown as ToolSet;

function configured(
  harness: HarnessShape | undefined,
  denyTools?: string[],
): ConfiguredOptions {
  return {
    agentConfig: {
      harness: harness,
      denyTools: denyTools,
      model: { provider: "anthropic", modelId: "claude-haiku-5-5" },
      provider: {
        anthropic: { apiKey: "test-key" },
        openai: { apiKey: "test-key" },
      },
    },
    compute: WORKDIR_COMPUTE,
    id: "agent-1",
    instructions: "Be brief.",
    reservationKey: "conversation",
    tools: TOOLS,
  } as unknown as ConfiguredOptions;
}

function lastBuilt(): Record<string, unknown> {
  return built[built.length - 1] ?? {};
}

describe("configured harness agents", () => {
  test("refuses a config with no harness", (): void => {
    expect((): unknown =>
      createConfiguredHarnessAgent(configured(undefined)),
    ).toThrow("config.harness is required");
  });

  test("refuses a compute that is not persistent", (): void => {
    const options = {
      ...configured({ type: "claude-code" }),
      compute: { provider: "sandbox", persistent: false },
    } as unknown as ConfiguredOptions;

    expect((): unknown => createConfiguredHarnessAgent(options)).toThrow(
      "persistent sandbox",
    );
  });

  test("drops denied names from activeTools", (): void => {
    createConfiguredHarnessAgent(
      configured({ type: "claude-code", activeTools: ["read", "shell"] }, [
        "shell",
      ]),
    );

    expect(lastBuilt().activeTools).toEqual(["read"]);
  });

  test("merges inactive and denied tools without duplicates", (): void => {
    createConfiguredHarnessAgent(
      configured({ type: "claude-code", inactiveTools: ["read", "shell"] }, [
        "shell",
        "custom",
      ]),
    );

    expect(lastBuilt().inactiveTools).toEqual(
      expect.arrayContaining(["read", "shell", "custom"]),
    );
  });

  test("sends no filtering when nothing is configured", (): void => {
    createConfiguredHarnessAgent(configured({ type: "claude-code" }));

    expect(lastBuilt().activeTools).toBeUndefined();
    expect(lastBuilt().id).toBe("agent-1");
  });

  test("refuses Codex outside allow-all", (): void => {
    expect((): unknown =>
      createConfiguredHarnessAgent(
        configured({ type: "codex", permissionMode: "ask" }),
      ),
    ).toThrow("Codex Harness requires permissionMode allow-all");
  });

  test("accepts Codex in allow-all", (): void => {
    const made = createConfiguredHarnessAgent(
      configured({ type: "codex", permissionMode: "allow-all" }),
    );

    expect(made.reservationKey.startsWith("conversation:codex:")).toBe(true);
  });
});

describe.each([
  "claude-code",
  "codex",
  "deepagents",
  "opencode",
  "pi",
] as const)("%s runtimes", (type): void => {
  test("builds a workdir runtime", (): void => {
    const made = createWorkdirHarnessAgent({
      compute: WORKDIR_COMPUTE,
      reservationKey: "workdir-key",
      tools: TOOLS,
      type: type,
    });

    expect(made.bridgePort).toBe(4321);
    expect(made.reservationKey.startsWith(`workdir-key:${type}:`)).toBe(true);
  });

  test("builds a microvm runtime on a chosen port with filters", (): void => {
    const made = createMicrovmHarnessAgent({
      activeTools: ["read", "askUserQuestions"],
      bridgePort: 5000,
      compute: MICROVM_COMPUTE,
      reservationKey: "vm-key",
      type: type,
    });

    expect(made.bridgePort).toBe(5000);
    expect(lastBuilt().activeTools).toEqual(["read"]);
  });

  test("keeps inactive tools and passes the optional settings", (): void => {
    createWorkdirHarnessAgent({
      compute: WORKDIR_COMPUTE,
      debug: { enabled: true } as unknown as WorkdirOptions["debug"],
      id: "agent-2",
      inactiveTools: ["read", "read"],
      instructions: "Short.",
      model: "model-a",
      permissionMode: "allow-all",
      reservationKey: "workdir-key",
      skills: [],
      toolApproval: {} as unknown as WorkdirOptions["toolApproval"],
      type: type,
    });

    expect(lastBuilt().telemetry).toEqual({
      functionId: `harness.${type}`,
      recordInputs: false,
      recordOutputs: false,
    });
    expect(lastBuilt().inactiveTools).toEqual(expect.arrayContaining(["read"]));
  });
});

describe("workdir compute", () => {
  test("refuses a sandbox with no workdir url", (): void => {
    const compute = {
      provider: "sandbox",
      persistent: true,
    } as unknown as WorkdirOptions["compute"];

    expect((): unknown =>
      createWorkdirHarnessAgent({
        compute: compute,
        reservationKey: "workdir-key",
        type: "pi",
      }),
    ).toThrow("workdirUrl");
  });
});

describe("configured harness skills", () => {
  test.each([
    { name: "no account", accountId: undefined, enabled: true },
    { name: "skills off", accountId: "acct_1", enabled: false },
    { name: "an empty account id", accountId: "", enabled: true },
  ])(
    "loads nothing with $name",
    async ({ accountId, enabled }): Promise<void> => {
      const config = {
        skills: { enabled: enabled, allowed: ["acct_1/one"] },
      } as unknown as AgentConfig;

      expect(await loadConfiguredHarnessSkills(accountId, config)).toEqual([]);
    },
  );
});

describe("harness diagnostics", () => {
  test.each(["error", "warn", "info", "debug"])(
    "logs a %s line",
    (level): void => {
      createWorkdirHarnessAgent({
        compute: WORKDIR_COMPUTE,
        reservationKey: "workdir-key",
        type: "claude-code",
      });
      const onLog = lastBuilt().onLog as (
        diagnostic: Record<string, unknown>,
      ) => void;

      expect((): void =>
        onLog({ level: level, message: "hello", kind: "note" }),
      ).not.toThrow();
    },
  );
});
