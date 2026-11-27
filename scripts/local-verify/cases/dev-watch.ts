import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "packages", "broods", "src", "cli", "index.ts");
const SDK = join(REPO_ROOT, "packages", "broods", "src", "index.ts");
const SYNC_WAIT_MS = 60_000;

// `broods dev` keeps the stage on the source: a save as it starts and a later one both land.
// A save landing mid-sync is timing-bound, so this checks the outcome, not that window.
export async function devWatch(context: VerifyContext): Promise<void> {
  const project = `watch-${context.runId}`;
  const dir = mkdtempSync(join(tmpdir(), "broods-dev-watch-"));
  const source = join(dir, "broods", "index.ts");
  mkdirSync(join(dir, "broods"));
  writeFileSync(source, agentSource("v1"));
  const client = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const child = spawn("bun", [CLI, "dev", "--project", project], {
    cwd: dir,
    env: {
      ...process.env,
      BROODS_BASE_URL: context.edgeUrl,
      BROODS_TOKEN: context.accountSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so the stop below also ends a running `dev --once` child.
    detached: true,
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer): void => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer): void => {
    output += chunk.toString();
  });
  try {
    writeFileSync(source, agentSource("v2"));
    await context.measure("a save as dev starts lands", () =>
      waitForSystem(client, project, "v2", (): string => output),
    );
    writeFileSync(source, agentSource("v3"));
    await context.measure("a later save lands", () =>
      waitForSystem(client, project, "v3", (): string => output),
    );
  } finally {
    if (child.pid) process.kill(-child.pid, "SIGINT");
    rmSync(dir, { recursive: true, force: true });
  }
}

function agentSource(version: string): string {
  return [
    `import { defineAgent } from ${JSON.stringify(SDK)};`,
    "",
    "export const agent = defineAgent({",
    '  name: "watched",',
    '  model: { provider: "anthropic", modelId: "claude-haiku-5-5" },',
    `  agent: { system: ${JSON.stringify(version)} },`,
    "});",
    "",
  ].join("\n");
}

async function waitForSystem(
  client: BroodsSyncClient,
  project: string,
  system: string,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + SYNC_WAIT_MS;
  let seen = "nothing";
  while (Date.now() < deadline) {
    const remote = await client
      .getManifest(project, "development")
      .catch(() => null);
    const agent = remote?.manifest.resources.find(
      (resource) => resource.kind === "agent",
    );
    seen = JSON.stringify(agent?.config ?? null);
    if (seen.includes(`"system":${JSON.stringify(system)}`)) return;
    await Bun.sleep(250);
  }
  assertStep(
    `the stage holds system ${system}`,
    false,
    `stage: ${seen}\n${output()}`,
  );
}
