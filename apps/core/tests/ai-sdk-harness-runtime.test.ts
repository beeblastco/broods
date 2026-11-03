import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import type {
  Outcome,
  RuntimeSummary,
} from "./helpers/harness-runtime-probe.ts";

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

const probe = Bun.spawnSync(
  [
    process.execPath,
    resolve(import.meta.dir, "helpers/harness-runtime-probe.ts"),
  ],
  { cwd: resolve(import.meta.dir, "..") },
);
if (probe.exitCode !== 0) throw new Error(probe.stderr.toString());
const OUTCOMES: Record<string, Outcome> = JSON.parse(probe.stdout.toString());
const TYPES = ["claude-code", "codex", "deepagents", "opencode", "pi"] as const;

function built(name: string): RuntimeSummary {
  const outcome = OUTCOMES[name];
  if (!outcome || "error" in outcome) {
    throw new Error(`${name}: ${outcome?.error ?? "not probed"}`);
  }

  return outcome.runtime;
}

function refused(name: string): string | undefined {
  const outcome = OUTCOMES[name];

  return outcome && "error" in outcome ? outcome.error : undefined;
}

describe.each([
  ["createWorkdirHarnessAgent", "workdir"],
  ["createMicrovmHarnessAgent", "microvm"],
] as const)("%s", (_, sandbox) => {
  it.each(TYPES)(
    "constructs the %s bridge on a version-scoped reservation",
    (type) => {
      const runtime = built(`${sandbox}:${type}`);

      expect(runtime.harnessId).toBe(type);
      expect(runtime.bridgePort).toBe(4_567);
      expect(runtime.bridgePorts).toEqual([4_567]);
      expect(runtime.reservationKey).toBe(runtime.versionedReservationKey);
    },
  );
});

describe("createWorkdirHarnessAgent", () => {
  it("rejects Codex permission modes the adapter cannot enforce", () => {
    expect(refused("codexAllowEdits")).toBe(
      "Codex Harness requires permissionMode allow-all",
    );
  });
});

describe("createConfiguredHarnessAgent", () => {
  it("maps a custom OpenAI-compatible model into Codex on Workdir", () => {
    const runtime = built("customCodex");

    expect(runtime.harnessId).toBe("codex");
    expect(runtime.reservationKey).toBe(runtime.versionedReservationKey);
  });

  it("maps tool filters and diagnostics into OpenCode", () => {
    const runtime = built("openCodeFilters");

    expect(runtime.harnessId).toBe("opencode");
    expect(runtime.reservationKey).toBe(runtime.versionedReservationKey);
    expect(runtime.activeTools).toEqual(["custom_tool"]);
    expect(runtime.debug).toEqual({
      enabled: true,
      level: "trace",
      subsystems: ["bridge"],
    });
    expect(JSON.stringify(runtime.builtinToolFiltering)).not.toContain("bash");
  });

  // The harness `askUserQuestions` builtin waits for an answer core never supplies.
  it("keeps the harness question prompt off where the adapter declares it", () => {
    const runtime = built("openCodeInactive");

    expect(runtime.inactiveTools).toEqual(["bash", "askUserQuestions"]);
    expect(runtime.builtinToolFiltering).toEqual({
      mode: "deny",
      toolNames: ["askUserQuestions", "bash"],
    });
    expect(built("codexDefault").inactiveTools).toBeUndefined();
    expect(built("openCodeExplicit").activeTools).toEqual(["bash"]);
  });

  // OpenCode reads a custom endpoint label as Anthropic; Deep Agents takes only Anthropic models.
  it.each([
    ["opencode", "the anthropic, openai, or vercel model provider"],
    ["deepagents", "the anthropic or vercel model provider"],
  ] as const)("rejects unsupported providers for %s", (type, providers) => {
    expect(refused(`custom:${type}`)).toBe(
      `config.harness.type ${type} requires ${providers}`,
    );
  });

  it("rejects ephemeral and unsupported sandbox providers", () => {
    expect(refused("ephemeral")).toBe(
      "config.harness requires a persistent sandbox using the sandbox or lambda provider",
    );
  });
});
