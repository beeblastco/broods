import { WorkOS } from "@workos-inc/node";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROBE_EMAIL } from "./lib/session";

const ENV_FILE = join(__dirname, "..", ".env.local");
const GITHUB_ENV = "development";

// `bun run probe:rotate`: gives the staging probe a fresh password in WorkOS, .env.local and CI.
async function main(): Promise<void> {
  const apiKey = process.env.WORKOS_API_KEY;
  // Production keeps its own password, only in the `production` secret.
  if (!apiKey?.startsWith("sk_test_")) {
    throw new Error(
      "WORKOS_API_KEY in .env.local must be the Staging key (sk_test_)",
    );
  }
  const workos = new WorkOS(apiKey);
  const users = await workos.userManagement.listUsers({ email: PROBE_EMAIL });
  const user = users.data[0];
  if (!user)
    throw new Error(`${PROBE_EMAIL} is not a user in this WorkOS environment`);
  const password = randomBytes(30).toString("base64url");
  writeEnv({ E2E_EMAIL: PROBE_EMAIL, E2E_PASSWORD: password });
  await workos.userManagement.updateUser({
    userId: user.id,
    password: password,
  });
  setSecret("DASHBOARD_E2E_EMAIL", PROBE_EMAIL);
  setSecret("DASHBOARD_E2E_PASSWORD", password);
  console.log(
    `Rotated ${PROBE_EMAIL}; rerun scripts/cloud-setup.sh for cloud sessions`,
  );
}

function setSecret(name: string, value: string): void {
  const result = spawnSync("gh", ["secret", "set", name, "--env", GITHUB_ENV], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new Error(`gh secret set ${name} failed`);
}

function writeEnv(values: Record<string, string>): void {
  const keys = Object.keys(values);
  const kept = readFileSync(ENV_FILE, "utf8")
    .split("\n")
    .filter(
      (line) => !keys.some((key) => line.startsWith(`${key}=`)) && line !== "",
    );
  const added = keys.map((key) => `${key}="${values[key]}"`);
  writeFileSync(ENV_FILE, `${[...kept, ...added].join("\n")}\n`);
}

await main();
