import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import type {
  Outcome,
  OutcomeName,
  RuntimeSummary,
} from "./helpers/harness-runtime-probe.ts";

const ADAPTERS_PATH = resolve(
  import.meta.dir,
  "../src/harness/ai-sdk-harness/adapters/index.ts",
);
const BRIDGE_TYPES = ["claude-code", "codex", "deepagents", "opencode"];
const TYPES = ["claude-code", "codex", "deepagents", "opencode", "pi"] as const;

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

// Started at load so it runs while the compile test above builds.
const probe = Bun.spawn(
  [
    process.execPath,
    resolve(import.meta.dir, "helpers/harness-runtime-probe.ts"),
  ],
  { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
);
const outcomes: Promise<Partial<Record<OutcomeName, Outcome>>> = (async () => {
  const [code, stdout, stderr] = await Promise.all([
    probe.exited,
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
  ]);
  if (code !== 0 || stderr.includes("HarnessAgent:")) throw new Error(stderr);

  return JSON.parse(stdout);
})();

async function built(name: OutcomeName): Promise<RuntimeSummary> {
  const outcome = (await outcomes)[name];
  if (!outcome || "error" in outcome) {
    throw new Error(`${name}: ${outcome?.error ?? "not probed"}`);
  }

  return outcome.runtime;
}

async function refused(name: OutcomeName): Promise<string | undefined> {
  const outcome = (await outcomes)[name];

  return outcome && "error" in outcome ? outcome.error : undefined;
}

describe.each([
  ["createWorkdirHarnessAgent", "workdir"],
  ["createMicrovmHarnessAgent", "microvm"],
] as const)("%s", (_, sandbox) => {
  it.each(TYPES)(
    "constructs the %s bridge on a version-scoped reservation",
    async (type) => {
      const runtime = await built(`${sandbox}:${type}`);

      expect(runtime.harnessId).toBe(type);
      expect(runtime.bridgePort).toBe(4_567);
      expect(runtime.bridgePorts).toEqual([4_567]);
      expect(runtime.reservationKey).toBe(runtime.versionedReservationKey);
    },
  );
});

describe("createWorkdirHarnessAgent", () => {
  it("rejects Codex permission modes the adapter cannot enforce", async () => {
    expect(await refused("codexAllowEdits")).toBe(
      "Codex Harness requires permissionMode allow-all",
    );
  });
});

describe("createConfiguredHarnessAgent", () => {
  it("maps a custom OpenAI-compatible model into Codex on Workdir", async () => {
    const runtime = await built("customCodex");

    expect(runtime.harnessId).toBe("codex");
    expect(runtime.reservationKey).toBe(runtime.versionedReservationKey);
  });

  it("maps tool filters and diagnostics into OpenCode", async () => {
    const runtime = await built("openCodeFilters");

    expect(runtime.harnessId).toBe("opencode");
    expect(runtime.reservationKey).toBe(runtime.versionedReservationKey);
    expect(runtime.activeTools).toEqual(["custom_tool"]);
    expect(runtime.debug).toEqual({
      enabled: true,
      level: "trace",
      subsystems: ["bridge"],
    });
    expect(runtime.builtinToolFiltering).toEqual({
      mode: "allow",
      toolNames: [],
    });
  });

  // The harness `askUserQuestions` builtin waits for an answer core never supplies.
  it("keeps the harness question prompt off where the adapter declares it", async () => {
    const runtime = await built("openCodeInactive");

    expect(runtime.inactiveTools).toEqual(["bash", "askUserQuestions"]);
    expect(runtime.builtinToolFiltering).toEqual({
      mode: "deny",
      toolNames: ["askUserQuestions", "bash"],
    });
    expect((await built("codexDefault")).inactiveTools).toBeUndefined();
    expect((await built("openCodeExplicit")).activeTools).toEqual(["bash"]);
  });

  // OpenCode maps a custom endpoint label to Anthropic, so an OpenAI-compatible key never lands.
  it.each([
    ["opencode", "the anthropic, openai, or vercel model provider"],
    ["deepagents", "the anthropic or vercel model provider"],
  ] as const)(
    "rejects unsupported providers for %s",
    async (type, providers) => {
      expect(await refused(`custom:${type}`)).toBe(
        `config.harness.type ${type} requires ${providers}`,
      );
    },
  );

  it("rejects ephemeral and unsupported sandbox providers", async () => {
    expect(await refused("ephemeral")).toBe(
      "config.harness requires a persistent sandbox using the sandbox or lambda provider",
    );
  });
});
