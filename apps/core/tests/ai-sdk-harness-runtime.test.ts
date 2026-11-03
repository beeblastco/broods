import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { jsonSchema, tool } from "ai";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import {
  createConfiguredHarnessAgent,
  createMicrovmHarnessAgent,
  createWorkdirHarnessAgent,
  harnessAdapterVersion,
  type ConfiguredHarnessAgentOptions,
} from "../src/harness/ai-sdk-harness/index.ts";

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

const ADAPTERS_PATH = resolve(
  import.meta.dir,
  "../src/harness/ai-sdk-harness/adapters/index.ts",
);
const BRIDGE_TYPES = ["claude-code", "codex", "deepagents", "opencode"];

// The compiled core binary only carries bridge files root `patches/` turn into embedded imports.
describe("createAiSdkHarnessAdapter", () => {
  it("builds every bridge bootstrap inside a compiled binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-bootstrap-"));
    try {
      await Bun.write(
        join(dir, "probe.ts"),
        `import { createAiSdkHarnessAdapter } from ${JSON.stringify(ADAPTERS_PATH)};
        const files = {};
        for (const type of ${JSON.stringify(BRIDGE_TYPES)}) {
          const recipe = await createAiSdkHarnessAdapter(type).getBootstrap();
          files[type] = recipe.files.map((file) => file.path.split("/").at(-1));
        }
        console.log(JSON.stringify(files));`,
      );
      const build = Bun.spawnSync([
        process.execPath,
        "build",
        "--compile",
        join(dir, "probe.ts"),
        "--outfile",
        join(dir, "probe"),
      ]);
      if (build.exitCode !== 0) throw new Error(build.stderr.toString());
      const run = Bun.spawnSync([join(dir, "probe")], { cwd: dir });
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      const files: Record<string, string[]> = JSON.parse(run.stdout.toString());

      for (const type of BRIDGE_TYPES) {
        expect(files[type]).toContain("pnpm-lock.yaml");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

const RESERVATION = "acct:agent:conversation";

function configured(
  agentConfig: AgentConfig,
  compute: ConfiguredHarnessAgentOptions["compute"] = COMPUTE,
) {
  return createConfiguredHarnessAgent({
    agentConfig: agentConfig,
    compute: compute,
    instructions: "",
    reservationKey: RESERVATION,
    tools: {},
  });
}

const TYPES = ["claude-code", "codex", "deepagents", "opencode", "pi"] as const;

describe("createWorkdirHarnessAgent", () => {
  it.each(TYPES)(
    "constructs the %s bridge on a version-scoped reservation",
    (type) => {
      const runtime = createWorkdirHarnessAgent({
        type: type,
        reservationKey: RESERVATION,
        compute: COMPUTE,
        bridgePort: 4567,
      });

      expect(runtime.agent.harnessId).toBe(type);
      expect(runtime.bridgePort).toBe(4_567);
      expect(runtime.sandbox.bridgePorts).toEqual([4_567]);
      expect(runtime.reservationKey).toBe(
        `${RESERVATION}:${type}:${harnessAdapterVersion(type)}`,
      );
    },
  );

  it("rejects Codex permission modes the adapter cannot enforce", () => {
    expect(() =>
      createWorkdirHarnessAgent({
        type: "codex",
        reservationKey: RESERVATION,
        compute: COMPUTE,
        permissionMode: "allow-edits",
      }),
    ).toThrow("Codex Harness requires permissionMode allow-all");
  });
});

describe("createConfiguredHarnessAgent", () => {
  it("maps a custom OpenAI-compatible model into Codex on Workdir", () => {
    const runtime = configured({
      harness: { type: "codex", permissionMode: "allow-all" },
      model: {
        provider: "custom",
        modelId: "Qwen3.6-27B",
        reasoning: "medium",
      },
      provider: {
        custom: {
          apiKey: "test-key",
          base_url: "https://llm.example.test/v1/",
        },
      },
    });

    expect(runtime.agent.harnessId).toBe("codex");
    expect(runtime.reservationKey).toStartWith(`${RESERVATION}:codex:`);
  });

  it("maps tool filters and diagnostics into OpenCode", () => {
    const runtime = createConfiguredHarnessAgent({
      agentConfig: {
        harness: {
          type: "opencode",
          activeTools: ["bash", "custom_tool"],
          debug: { enabled: true, level: "trace", subsystems: ["bridge"] },
        },
        denyTools: ["bash"],
        model: { provider: "openai", modelId: "gpt-5.1", reasoning: "high" },
        provider: { openai: { apiKey: "test-key" } },
      },
      compute: COMPUTE,
      instructions: "Work carefully.",
      reservationKey: RESERVATION,
      tools: {
        custom_tool: tool({
          description: "custom",
          inputSchema: jsonSchema({}),
        }),
      },
    });

    expect(runtime.agent.harnessId).toBe("opencode");
    expect(runtime.reservationKey).toStartWith(`${RESERVATION}:opencode:`);
    expect(runtime.agent["settings"].activeTools).toEqual(["custom_tool"]);
    expect(runtime.agent["settings"].debug).toEqual({
      enabled: true,
      level: "trace",
      subsystems: ["bridge"],
    });
    expect(JSON.stringify(runtime.agent["builtinToolFiltering"])).not.toContain(
      "bash",
    );
  });

  // The harness `askUserQuestions` builtin waits for an answer core never supplies.
  it("keeps the harness question prompt off where the adapter declares it", () => {
    const openai = { openai: { apiKey: "test-key" } };
    const model = { provider: "openai", modelId: "gpt-5.1" } as const;
    const runtime = configured({
      harness: { type: "opencode", inactiveTools: ["bash"] },
      model: model,
      provider: openai,
    });
    const codex = configured({
      harness: { type: "codex", permissionMode: "allow-all" },
      model: model,
      provider: openai,
    });
    const explicit = configured({
      harness: { type: "opencode", activeTools: ["bash", "askUserQuestions"] },
      model: model,
      provider: openai,
    });

    expect(runtime.agent["settings"].inactiveTools).toEqual([
      "bash",
      "askUserQuestions",
    ]);
    expect(runtime.agent["builtinToolFiltering"]).toEqual({
      mode: "deny",
      toolNames: ["askUserQuestions", "bash"],
    });
    expect(codex.agent["settings"].inactiveTools).toBeUndefined();
    expect(explicit.agent["settings"].activeTools).toEqual(["bash"]);
  });

  // OpenCode maps a custom endpoint label to Anthropic, so an OpenAI-compatible key never lands.
  it.each([
    ["opencode", "the anthropic, openai, or vercel model provider"],
    ["deepagents", "the anthropic or vercel model provider"],
  ] as const)("rejects unsupported providers for %s", (type, providers) => {
    expect(() =>
      configured({
        harness: { type: type },
        model: { provider: "custom", modelId: "Qwen3.6-27B" },
        provider: {
          custom: {
            apiKey: "test-key",
            base_url: "https://llm.example.test/v1/",
          },
        },
      }),
    ).toThrow(`config.harness.type ${type} requires ${providers}`);
  });

  it("rejects ephemeral and unsupported sandbox providers", () => {
    expect(() =>
      configured(
        {
          harness: { type: "codex" },
          model: { provider: "openai", modelId: "gpt-5" },
          provider: { openai: { apiKey: "test-key" } },
        },
        {
          provider: "vercel",
          persistent: false,
          network: { mode: "allow-all" },
        },
      ),
    ).toThrow(
      "config.harness requires a persistent sandbox using the sandbox or lambda provider",
    );
  });
});

describe("createMicrovmHarnessAgent", () => {
  it.each(TYPES)(
    "constructs the %s bridge on a version-scoped MicroVM reservation",
    (type) => {
      const runtime = createMicrovmHarnessAgent({
        type: type,
        reservationKey: RESERVATION,
        compute: MICROVM_COMPUTE,
        bridgePort: 4567,
      });

      expect(runtime.agent.harnessId).toBe(type);
      expect(runtime.sandbox.bridgePorts).toEqual([4_567]);
      expect(runtime.reservationKey).toBe(
        `${RESERVATION}:${type}:${harnessAdapterVersion(type)}`,
      );
    },
  );
});
