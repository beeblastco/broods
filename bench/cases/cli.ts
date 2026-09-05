/**
 * The developer's side of the product. Compiling a `broods/` project is the
 * CPU a developer waits on before every sync; `broods dev` does it twice on
 * start (once to print the target, once in the sync child) and `broods run`
 * a third time. The startup cases are what an installed CLI costs before it
 * does anything, under both runtimes people install it with.
 */

import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { compileProject } from "../../packages/broods/src/manifest.ts";
import type { BenchCase } from "../runner.ts";

const ROOT = resolve(import.meta.dir, "../..");
const FIXTURE_PROJECT = resolve(import.meta.dir, "../fixtures/project");
const FIXTURE_SDK_LINK = resolve(FIXTURE_PROJECT, "node_modules/broods");
const CLI_DIST = resolve(ROOT, "packages/broods/dist/cli/index.js");
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
    setup: linkSdkIntoFixture,
    // Same process, so the project's modules stay in the import cache and this
    // is manifest assembly alone: the resource walk, the validation passes and
    // the sort. The cold case below is what a developer actually waits on.
    run: (): Promise<unknown> => compileProject(COMPILE_OPTIONS),
  },
  {
    name: "cli/compile-project-cold",
    iterations: 1,
    samples: 7,
    setup: linkSdkIntoFixture,
    // A fresh process per compile, the way the CLI actually runs it.
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

/**
 * The fixture imports `broods` the way a user project does. Root node_modules
 * is Bun's isolated layout with no top-level link, so the SDK is linked in by
 * hand: no install, no network, and the workspace's own dependencies resolve
 * through the link's real path.
 */
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
