import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { compileProject } from "../../packages/broods/src/manifest.ts";
import type { BenchCase } from "../runner.ts";

const ROOT = resolve(import.meta.dir, "../..");
const FIXTURE_PROJECT = resolve(import.meta.dir, "../fixtures/project");
const FIXTURE_SDK_LINK = resolve(FIXTURE_PROJECT, "node_modules/broods");
const CLI_DIST = resolve(ROOT, "packages/broods/dist/cli/index.js");
const SDK_DIST = resolve(ROOT, "packages/broods/dist/index.js");
const COMPILE_ONCE = resolve(import.meta.dir, "../fixtures/compile-once.ts");
const COMPILE_OPTIONS = {
  cwd: FIXTURE_PROJECT,
  project: "bench",
  command: "dev",
  stage: "development",
  useRuntimeStage: false,
} as const;

export const cliCases: readonly BenchCase[] = [
  {
    name: "cli/compile-project-cached",
    iterations: 20,
    samples: 11,
    available: (): boolean => existsSync(SDK_DIST),
    setup: linkSdkIntoFixture,
    // Same process, so imports stay cached: manifest assembly alone, not the cold compile.
    run: (): Promise<unknown> => compileProject(COMPILE_OPTIONS),
  },
  {
    name: "cli/compile-project-cold",
    iterations: 1,
    samples: 7,
    available: (): boolean => existsSync(SDK_DIST),
    setup: linkSdkIntoFixture,
    run: (): unknown => spawnChecked(["bun", COMPILE_ONCE, FIXTURE_PROJECT]),
  },
  {
    name: "cli/startup-node",
    iterations: 1,
    samples: 9,
    available: (): boolean => existsSync(CLI_DIST),
    run: (): unknown => spawnChecked(["node", CLI_DIST, "--version"]),
  },
  {
    name: "cli/startup-bun",
    iterations: 1,
    samples: 9,
    available: (): boolean => existsSync(CLI_DIST),
    run: (): unknown => spawnChecked(["bun", CLI_DIST, "--version"]),
  },
];

// Root node_modules is Bun's isolated layout with no top-level `broods`, so link the SDK
// by hand: no install, no network, and its own dependencies resolve via the real path.
function linkSdkIntoFixture(): void {
  if (existsSync(FIXTURE_SDK_LINK)) return;
  mkdirSync(resolve(FIXTURE_PROJECT, "node_modules"), { recursive: true });
  symlinkSync(resolve(ROOT, "packages/broods"), FIXTURE_SDK_LINK, "dir");
}

function spawnChecked(command: string[]): number {
  const result = Bun.spawnSync(command, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().slice(0, 400)}`,
    );
  }

  return result.stdout.length;
}
