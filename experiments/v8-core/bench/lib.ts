/**
 * Shared bench helpers: the local stack's state, an account on it, and SDK
 * clients aimed at one runtime (Bun core or core on workerd). Setup always goes
 * through the edge, so both runtimes run agents from the same config plane.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { BroodsAccountClient } from "../../../packages/broods/src/account.ts";
import { BroodsClient } from "../../../packages/broods/src/client.ts";
import { createAccountSecret } from "../../../packages/convex/model/accountSecrets.ts";

export interface StackState {
  instanceId: string;
  portBase: number;
  secrets: { adminAccount: string };
}

export const RUNTIMES = {
  bun: "http://127.0.0.1:4301",
  workerd: "http://127.0.0.1:4311",
  // A fresh isolate per request (per-task/router.js).
  isolate: "http://127.0.0.1:4321",
} as const;
export type Runtime = keyof typeof RUNTIMES;

export function stackState(): StackState {
  const dir = join(homedir(), ".broods-local");
  const instance = process.env.BROODS_LOCAL_INSTANCE ?? "broods-84a0a314";

  return JSON.parse(readFileSync(join(dir, instance, "state.json"), "utf8"));
}

export function edgeUrl(state: StackState): string {
  return `http://127.0.0.1:${state.portBase}`;
}

export async function createAccount(
  state: StackState,
  username: string,
): Promise<string> {
  const response = await fetch(`${edgeUrl(state)}/v1/accounts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.secrets.adminAccount}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username: username }),
  });
  const body = (await response.json()) as { secret?: string; error?: string };
  if (response.status !== 201 || !body.secret) {
    throw new Error(`create account: ${response.status} ${body.error}`);
  }

  return body.secret;
}

export function accountClient(
  state: StackState,
  secret: string,
): BroodsAccountClient {
  return new BroodsAccountClient({
    accountSecret: secret,
    baseUrl: edgeUrl(state),
  });
}

export function runtimeClient(runtime: Runtime, secret: string): BroodsClient {
  return new BroodsClient({ apiKey: secret, baseUrl: RUNTIMES[runtime] });
}

export function haikuModel(apiKey: string): Record<string, unknown> {
  return {
    model: {
      provider: "anthropic",
      modelId: "claude-haiku-5-5",
      reasoning: "high",
    },
    provider: { anthropic: { apiKey: apiKey } },
  };
}

export const COMPLEX_SYSTEM =
  "You are a build assistant. Use your tools exactly as asked. Keep the final answer under 80 words.";

export const complexTask = (dir: string): string =>
  [
    `Do all of these. Work only inside the folder ${dir} (create it first) and pass that folder to the subagent.`,
    "1. Search the Cloudflare docs with your Cloudflare docs MCP tool for the Workers CPU time limit on the paid plan, and note the number.",
    `2. In bash, create ${dir}/notes/limits.md containing that number, then print its sha256sum.`,
    `3. Start one subagent with run_subagent for this long task, and do not wait for it: 'In bash, inside the folder ${dir}, write primes.sh that prints every prime below 30000 and run it, saving the list to primes.txt. Report how many primes there are and the largest one.'`,
    "4. Reply with the sha256 and say the subagent is running.",
  ].join("\n");

/** The complex agent's config on one sandbox: MCP, bash with files, and subagents. */
export function complexConfig(
  apiKey: string,
  sandboxId: string,
  mcpServerId: string,
): Record<string, unknown> {
  return {
    ...haikuModel(apiKey),
    agent: { system: COMPLEX_SYSTEM },
    sandboxes: [sandboxId],
    mcp: { [mcpServerId]: { enabled: true, needsApproval: false } },
    subagent: { enabled: true },
  };
}

function stackConvex(args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["bun", "scripts/local-stack.ts", "convex", ...args],
    cwd: new URL("../../..", import.meta.url).pathname,
    env: { ...process.env, BUN_OPTIONS: "" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`convex ${args[0]}: ${result.stderr.toString()}`);
  }

  return result.stdout.toString();
}

/**
 * An org-backed account, the way `local-stack verify` makes one: manifest sync
 * and stage resources need an org, which admin-API accounts lack.
 */
export function createOrgAccount(slug: string): string {
  const path = join(tmpdir(), `bench-org-${slug}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({ name: slug, slug: slug, ownerAuthId: `local-${slug}`, plan: "free", createdAt: Date.now() })}\n`,
  );
  stackConvex(["import", "--append", "--table", "orgs", path]);
  const orgs = JSON.parse(
    stackConvex(["data", "orgs", "--format", "json"]),
  ) as { _id: string; slug: string }[];
  const org = orgs.find((entry) => entry.slug === slug);
  if (!org) throw new Error("org not found after import");
  const secret = createAccountSecret();
  stackConvex([
    "run",
    "account/accounts:create",
    JSON.stringify({
      orgId: org._id,
      username: slug,
      secretHash: createHash("sha256").update(secret).digest("hex"),
    }),
  ]);

  return secret;
}
