// The stub pooled runner answers each call with the sha256 of the bundle it was handed.

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shutdownIsolatePool } from "../src/harness/isolate/executor.ts";
import type { AccountHookRecord } from "../src/shared/domain/account-hooks.ts";

const dir = await mkdtemp(join(tmpdir(), "broods-hook-cache-"));
const runnerPath = join(dir, "runner.mjs");
await writeFile(
  runnerPath,
  `import { createHash } from "node:crypto";
process.stdout.write(JSON.stringify({ t: "ready" }) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const { callId, payload } = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    const sha = createHash("sha256").update(Buffer.from(payload.bundleSourceB64, "base64")).digest("hex");
    process.stdout.write(JSON.stringify({ t: "final", callId, result: { result: { system: sha }, state: {} } }) + "\\n");
  }
});`,
  "utf8",
);
process.env.ISOLATE_RUNNER_PATH = runnerPath;
process.env.TOOL_BUNDLES_BUCKET_NAME = "hook-cache-fixture";
delete process.env.ISOLATE_POOL;

// Each key's next answers; an Error entry fails that read, and the last entry repeats.
const objects = new Map<string, Array<Uint8Array | Error>>();
const reads: string[] = [];
await mock.module("../src/shared/s3.ts", () => ({
  readS3Bytes: async (_bucket: string, key: string): Promise<Uint8Array> => {
    reads.push(key);
    const answers = objects.get(key)!;
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (answer instanceof Error) throw answer;

    return answer;
  },
}));
const { runCodeHook } = await import("../src/harness/hook-runner.ts");

beforeEach((): void => {
  reads.length = 0;
});

afterAll(async (): Promise<void> => {
  shutdownIsolatePool();
  await rm(dir, { recursive: true, force: true });
});

let hooks = 0;

function hook(
  bundle: string,
  answers: Array<string | Error> = [bundle],
): AccountHookRecord {
  hooks += 1;
  const key = `account-hooks/acct_cache/${hooks}`;
  objects.set(
    key,
    answers.map((answer) =>
      answer instanceof Error ? answer : new TextEncoder().encode(answer),
    ),
  );

  return {
    accountId: "acct_cache",
    hookId: `hook_${hooks}`,
    name: "cache",
    events: ["agent.started"],
    bundleStorageKey: key,
    sha256: sha256(bundle),
    status: "active",
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
  };
}

async function fire(record: AccountHookRecord): Promise<unknown> {
  const outcome = await runCodeHook({
    accountId: record.accountId,
    record: record,
    event: "agent.started",
    payload: { system: "base" },
    config: {
      model: {},
      tools: [],
      mcp: [],
      channels: [],
      skills: [],
      subagents: [],
      denyTools: [],
    },
    state: {},
  });

  return outcome.mutation?.system;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("ten fires of one hook read its bundle from S3 once", async (): Promise<void> => {
  const record = hook(
    "export default {};\n/*" + "x".repeat(1024 * 1024) + "*/",
  );
  for (let index = 0; index < 10; index += 1) {
    expect(await fire(record)).toBe(record.sha256);
  }

  expect(reads).toEqual([record.bundleStorageKey]);
});

test("concurrent fires share one read", async (): Promise<void> => {
  const record = hook("export default { concurrent: true };");
  const seen = await Promise.all(Array.from({ length: 5 }, () => fire(record)));

  expect(seen).toEqual(Array(5).fill(record.sha256));
  expect(reads).toHaveLength(1);
});

test("a failed read is not kept, so the next fire reads again", async (): Promise<void> => {
  const bundle = "export default { flaky: true };";
  const record = hook(bundle, [new Error("S3 unavailable"), bundle]);

  expect(await fire(record)).toBeUndefined();
  expect(await fire(record)).toBe(record.sha256);
  expect(await fire(record)).toBe(record.sha256);
  expect(reads).toHaveLength(2);
});

test("bytes that do not match the sha256 are not kept", async (): Promise<void> => {
  const bundle = "export default { verified: true };";
  const record = hook(bundle, ["export default { tampered: true };", bundle]);

  expect(await fire(record)).toBeUndefined();
  expect(await fire(record)).toBe(record.sha256);
  expect(reads).toHaveLength(2);
});

test("a new version of a hook runs its new bundle, never the cached one", async (): Promise<void> => {
  const first = hook("export default { version: 1 };");
  expect(await fire(first)).toBe(first.sha256);
  const next = "export default { version: 2 };";
  objects.set(first.bundleStorageKey, [new TextEncoder().encode(next)]);
  const updated = { ...first, sha256: sha256(next) };

  expect(await fire(updated)).toBe(updated.sha256);
  expect(reads).toEqual([first.bundleStorageKey, first.bundleStorageKey]);
});

test("the cache drops the least recently used bundle past its byte budget", async (): Promise<void> => {
  // Seven 1 MB bundles (the upload cap) encode to about 9.3 MB, past the 8 MiB budget.
  const records = Array.from({ length: 7 }, (_, index) =>
    hook(`export default {};/*${index}*/` + "x".repeat(1_000_000 - 30)),
  );
  for (const record of records) await fire(record);
  expect(reads).toHaveLength(7);
  reads.length = 0;

  expect(await fire(records[6]!)).toBe(records[6]!.sha256);
  expect(await fire(records[1]!)).toBe(records[1]!.sha256);
  expect(reads).toEqual([]);
  expect(await fire(records[0]!)).toBe(records[0]!.sha256);
  expect(reads).toEqual([records[0]!.bundleStorageKey]);
});
