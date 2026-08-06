/**
 * Broods AI SDK Harness runtime construction tests.
 * Each probe runs in a child process so importing the real driver cannot prime
 * Bun's module cache ahead of executor tests that install module-level fakes.
 * Live bridge bootstrap and connectivity are covered by the opt-in integration test.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";

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

const MODULE_URL = pathToFileURL(
  resolve(import.meta.dir, "../src/harness/ai-sdk-harness/index.ts"),
).href;

describe("createWorkdirHarnessAgent", () => {
  it.each(["claude-code", "codex", "deepagents", "opencode", "pi"] as const)(
    "constructs the %s bridge on a version-scoped reservation",
    async (type) => {
      const result = await runProbe(`
        const runtime = module.createWorkdirHarnessAgent({
          type: ${JSON.stringify(type)},
          reservationKey: "acct:agent:conversation",
          compute: ${JSON.stringify(COMPUTE)},
          bridgePort: 4567,
        });
        console.log(JSON.stringify({
          harnessId: runtime.agent.harnessId,
          bridgePort: runtime.bridgePort,
          reservationKey: runtime.reservationKey,
          expectedReservationKey:
            "acct:agent:conversation:" +
            ${JSON.stringify(type)} +
            ":" +
            module.harnessRuntimeVersion(${JSON.stringify(type)}),
          bridgePorts: runtime.sandbox.bridgePorts,
        }));
      `);

      const parsed = JSON.parse(result);
      expect(parsed).toMatchObject({
        harnessId: type,
        bridgePort: 4_567,
        bridgePorts: [4_567],
      });
      expect(parsed.reservationKey).toBe(parsed.expectedReservationKey);
    },
  );

  it("rejects Codex permission modes the adapter cannot enforce", async () => {
    const result = await runProbe(`
      try {
        module.createWorkdirHarnessAgent({
          type: "codex",
          reservationKey: "acct:agent:conversation",
          compute: ${JSON.stringify(COMPUTE)},
          permissionMode: "allow-edits",
        });
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
    `);

    expect(result).toBe("Codex Harness requires permissionMode allow-all");
  });
});

describe("createConfiguredHarnessAgent", () => {
  it("maps a custom OpenAI-compatible model into Codex on Workdir", async () => {
    const result = await runProbe(`
      const runtime = module.createConfiguredHarnessAgent({
        agentConfig: {
          harness: { type: "codex", permissionMode: "allow-all" },
          model: { provider: "custom", modelId: "Qwen3.6-27B", reasoning: "medium" },
          provider: {
            custom: {
              apiKey: "test-key",
              base_url: "https://llm.example.test/v1/",
            },
          },
        },
        compute: ${JSON.stringify(COMPUTE)},
        instructions: "Work carefully.",
        reservationKey: "acct:agent:conversation",
        tools: {},
      });
      console.log(JSON.stringify({
        harnessId: runtime.agent.harnessId,
        reservationKey: runtime.reservationKey,
        activeUserToolNames: Object.keys(runtime.agent.activeUserTools),
        builtinToolFiltering: runtime.agent.builtinToolFiltering,
        debug: runtime.agent.settings.debug,
      }));
    `);

    expect(JSON.parse(result)).toMatchObject({
      harnessId: "codex",
      reservationKey: expect.stringContaining("acct:agent:conversation:codex:"),
    });
  });

  it("maps custom models, tool filters, and diagnostics into OpenCode", async () => {
    const result = await runProbe(`
      const runtime = module.createConfiguredHarnessAgent({
        agentConfig: {
          harness: {
            type: "opencode",
            activeTools: ["bash", "custom_tool"],
            debug: { enabled: true, level: "trace", subsystems: ["bridge"] },
          },
          denyTools: ["bash"],
          model: { provider: "custom", modelId: "Qwen3.6-27B", reasoning: "high" },
          provider: {
            custom: {
              apiKey: "test-key",
              base_url: "https://llm.example.test/v1/",
            },
          },
        },
        compute: ${JSON.stringify(COMPUTE)},
        instructions: "Work carefully.",
        reservationKey: "acct:agent:conversation",
        tools: {
          custom_tool: { description: "custom", inputSchema: { jsonSchema: {} } },
        },
      });
      console.log(JSON.stringify({
        harnessId: runtime.agent.harnessId,
        reservationKey: runtime.reservationKey,
        activeUserToolNames: Object.keys(runtime.agent.activeUserTools),
        builtinToolFiltering: runtime.agent.builtinToolFiltering,
        debug: runtime.agent.settings.debug,
      }));
    `);

    expect(JSON.parse(result)).toMatchObject({
      harnessId: "opencode",
      reservationKey: expect.stringContaining(
        "acct:agent:conversation:opencode:",
      ),
      activeUserToolNames: ["custom_tool"],
      debug: {
        enabled: true,
        level: "trace",
        subsystems: ["bridge"],
      },
    });
    expect(
      JSON.stringify(JSON.parse(result).builtinToolFiltering),
    ).not.toContain("bash");
  });

  it("rejects unsupported providers for Deep Agents", async () => {
    const result = await runProbe(`
      try {
        module.createConfiguredHarnessAgent({
          agentConfig: {
            harness: { type: "deepagents" },
            model: { provider: "custom", modelId: "Qwen3.6-27B" },
            provider: {
              custom: {
                apiKey: "test-key",
                base_url: "https://llm.example.test/v1/",
              },
            },
          },
          compute: ${JSON.stringify(COMPUTE)},
          instructions: "",
          reservationKey: "acct:agent:conversation",
          tools: {},
        });
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
    `);

    expect(result).toBe(
      "config.harness.type deepagents requires the anthropic or vercel model provider",
    );
  });

  it("rejects ephemeral and unsupported sandbox providers", async () => {
    const result = await runProbe(`
      try {
        module.createConfiguredHarnessAgent({
          agentConfig: {
            harness: { type: "codex" },
            model: { provider: "openai", modelId: "gpt-5" },
            provider: { openai: { apiKey: "test-key" } },
          },
          compute: {
            provider: "vercel",
            persistent: false,
            network: { mode: "allow-all" },
          },
          instructions: "",
          reservationKey: "acct:agent:conversation",
          tools: {},
        });
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
    `);

    expect(result).toBe(
      "config.harness requires a persistent sandbox using the sandbox or lambda provider",
    );
  });
});

describe("createMicrovmHarnessAgent", () => {
  it.each(["claude-code", "codex", "deepagents", "opencode", "pi"] as const)(
    "constructs the %s bridge on a version-scoped MicroVM reservation",
    async (type) => {
      const result = await runProbe(`
        const runtime = module.createMicrovmHarnessAgent({
          type: ${JSON.stringify(type)},
          reservationKey: "acct:agent:conversation",
          compute: ${JSON.stringify(MICROVM_COMPUTE)},
          bridgePort: 4567,
        });
        console.log(JSON.stringify({
          harnessId: runtime.agent.harnessId,
          bridgePort: runtime.bridgePort,
          reservationKey: runtime.reservationKey,
          expectedReservationKey:
            "acct:agent:conversation:" +
            ${JSON.stringify(type)} +
            ":" +
            module.harnessRuntimeVersion(${JSON.stringify(type)}),
          bridgePorts: runtime.sandbox.bridgePorts,
        }));
      `);

      const parsed = JSON.parse(result);
      expect(parsed).toMatchObject({
        harnessId: type,
        bridgePort: 4_567,
        bridgePorts: [4_567],
      });
      expect(parsed.reservationKey).toBe(parsed.expectedReservationKey);
    },
  );
});

async function runProbe(body: string): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `const module = await import(${JSON.stringify(MODULE_URL)}); ${body}`,
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || `Harness runtime probe exited ${exitCode}`,
    );
  }
  return stdout.trim();
}
