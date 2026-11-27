import { describe, expect, mock, test } from "bun:test";
import { gzipSync } from "node:zlib";

import type { AccountHookRecord } from "../../../../apps/core/src/shared/domain/account-hooks.ts";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";
import type { ResolvedWorkspace } from "../../../../apps/core/src/shared/workspaces.ts";

type SandboxResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  truncated?: boolean;
};
type ConversationWorkspace = ResolvedWorkspace & {
  sandbox: NonNullable<ResolvedWorkspace["sandbox"]>;
};

const getById = mock(
  async (_accountId: string, id: string): Promise<AccountHookRecord | null> =>
    hookRecords.get(id) ?? null,
);
const runCodeHook = mock(
  async (input: {
    state: Record<string, unknown>;
  }): Promise<{
    mutation?: Record<string, unknown>;
    state: Record<string, unknown>;
  }> => ({
    mutation: { seen: Object.keys(input.state).length },
    state: { ...input.state, ran: true },
  }),
);
const runSandbox = mock(async (): Promise<SandboxResult> => nextSandboxResult);

const STORAGE_PATH = import.meta
  .resolve("../../../../apps/core/src/shared/storage.ts");
const RUNNER_PATH = import.meta
  .resolve("../../../../apps/core/src/harness/hook-runner.ts");
const FS_PATH = import.meta
  .resolve("../../../../apps/core/src/harness/tools/filesystem-utils.ts");
const realStorage = await import(STORAGE_PATH);
const realRunner = await import(RUNNER_PATH);
const realFs = await import(FS_PATH);

await mock.module(STORAGE_PATH, () => ({
  ...realStorage,
  getStorage: (): object => ({ accountHooks: { getById: getById } }),
}));
await mock.module(RUNNER_PATH, () => ({
  ...realRunner,
  runCodeHook: runCodeHook,
}));
await mock.module(FS_PATH, () => ({ ...realFs, runSandbox: runSandbox }));

// The workspace preload loads log.ts before the recorder exists; evict it to load a recorded one.
const LOG_PATH = import.meta.resolve("../../../../apps/core/src/shared/log.ts");
delete require.cache[Bun.fileURLToPath(LOG_PATH)];
const { collectSecretValues, redact, redactSerialized, redactWithRunSecrets } =
  (await import(
    LOG_PATH
  )) as typeof import("../../../../apps/core/src/shared/log.ts");

// Lazy so the module mocks above are in place first.
const { createAgentHookDispatcher, createHookDispatcher } =
  await import("../../../../apps/core/src/harness/hook-dispatcher.ts");
const { readConversationFiles, writeConversationFiles } =
  await import("../../../../apps/core/src/harness/conversation-files.ts");

const hookRecords = new Map<string, AccountHookRecord>([
  [
    "hook_a",
    hookRecord("hook_a", "active", ["tool.result", "tool.call.started"]),
  ],
  ["hook_b", hookRecord("hook_b", "active", ["tool.result"])],
  ["hook_off", hookRecord("hook_off", "disabled", ["tool.result"])],
]);
let nextSandboxResult: SandboxResult = { ok: true, stdout: "", stderr: "" };

const WORKSPACE = {
  name: "repo",
  workspaceId: "ws_1",
  namespace: "repo-ns",
  config: { storage: { provider: "s3" } },
  sandbox: { provider: "lambda" },
} as unknown as ConversationWorkspace;

function hookRecord(
  hookId: string,
  status: string,
  events: string[],
): AccountHookRecord {
  return {
    hookId: hookId,
    status: status,
    events: events,
  } as unknown as AccountHookRecord;
}

function gzipBase64(text: string): string {
  return gzipSync(Buffer.from(text, "utf8")).toString("base64");
}

describe("collectSecretValues", () => {
  test.each([
    { name: "scalar", value: "plain", expected: [] },
    { name: "null", value: null, expected: [] },
    {
      name: "secret-named key",
      value: { apiKey: "abcd1234", title: "not-secret" },
      expected: ["abcd1234"],
    },
    { name: "too short", value: { apiKey: "abc" }, expected: [] },
    {
      name: "named entry",
      value: [
        { name: "API_TOKEN", value: "tok-value" },
        { key: "COLOR", value: "blue-value" },
      ],
      expected: ["tok-value"],
    },
    {
      name: "env object keeps non-public names",
      value: { env: { SOME_VALUE: "kept-value", USER_EMAIL: "a@b.co" } },
      expected: ["kept-value"],
    },
    {
      name: "env array of entries",
      value: {
        "environment-variables": [
          { name: "GIT_AUTHOR_NAME", value: "A Person" },
          { name: "PLAIN", value: "array-value" },
          { value: "nameless-value" },
          "skipped",
        ],
      },
      expected: ["array-value", "nameless-value"],
    },
    {
      name: "nested and deduplicated",
      value: { a: { password: "same-secret" }, b: [{ token: "same-secret" }] },
      expected: ["same-secret"],
    },
  ])("$name", ({ value, expected }): void => {
    expect(collectSecretValues(value)).toEqual(expected);
  });
});

describe("redactSerialized", () => {
  test.each([
    {
      name: "string under limit",
      value: "hello",
      secrets: [],
      max: 20,
      expected: "hello",
    },
    {
      name: "object hides secret keys",
      value: { apiKey: "k", note: "n" },
      secrets: [],
      max: 100,
      expected: '{"apiKey":"[redacted]","note":"n"}',
    },
    {
      name: "secret value scrubbed",
      value: "my s3cret-value here",
      secrets: ["s3cret-value"],
      max: 100,
      expected: "my [redacted] here",
    },
    {
      name: "truncated at the end of the text",
      value: "aaaaaaaaaaaa",
      secrets: [],
      max: 5,
      expected: "aaaaa...[truncated]",
    },
    {
      name: "truncated at a window",
      value: "aaaa bbbb cccc dddd",
      secrets: [],
      max: 5,
      expected: "aaaa ...[truncated]",
    },
    { name: "undefined", value: undefined, secrets: [], max: 5, expected: "" },
  ])("$name", ({ value, secrets, max, expected }): void => {
    expect(redactSerialized(value, secrets, max)).toBe(expected);
  });

  test("a value JSON.stringify rejects falls back to String", (): void => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;

    expect(redactSerialized(cycle, [], 40)).toBe("[object Object]");
  });
});

describe("redactWithRunSecrets", () => {
  test.each([
    { name: "string", value: "has top-secret", expected: "has [redacted]" },
    { name: "number", value: 7, expected: 7 },
    { name: "null", value: null, expected: null },
    {
      name: "keeps keys, walks arrays and objects",
      value: { token: ["top-secret", { note: "top-secret!" }] },
      expected: { token: ["[redacted]", { note: "[redacted]!" }] },
    },
    { name: "date", value: new Date(0), expected: "1970-01-01T00:00:00.000Z" },
  ])("$name", ({ value, expected }): void => {
    expect(redactWithRunSecrets(value, ["top-secret"])).toEqual(expected);
  });

  test("redact hides secret-named keys", (): void => {
    expect(redact({ password: "x", note: "ok" }, [])).toEqual({
      password: "[redacted]",
      note: "ok",
    });
  });
});

describe("hook dispatchers", () => {
  const config = (code: unknown[]): AgentConfig =>
    ({ hooks: { code: code } }) as AgentConfig;

  test.each([
    { name: "no account", accountId: undefined, code: [{ hookId: "hook_a" }] },
    { name: "no refs", accountId: "acct_1", code: [] },
    {
      name: "disabled ref",
      accountId: "acct_1",
      code: [{ hookId: "hook_a", enabled: false }],
    },
    {
      name: "inactive record",
      accountId: "acct_1",
      code: [{ hookId: "hook_off" }],
    },
    {
      name: "missing record",
      accountId: "acct_1",
      code: [{ hookId: "hook_gone" }],
    },
  ])("$name has no hooks", async ({ accountId, code }): Promise<void> => {
    const dispatcher = await createAgentHookDispatcher(accountId, config(code));

    expect(dispatcher.hasHooksFor("tool.result")).toBe(false);
    expect(await dispatcher.runMutation("tool.result", {})).toBeUndefined();
  });

  test("indexes active records, honouring a ref's event filter", async (): Promise<void> => {
    const dispatcher = await createAgentHookDispatcher(
      "acct_1",
      config([
        { hookId: "hook_a", events: ["tool.result"] },
        { hookId: "hook_b" },
        { hookId: "hook_a" },
      ]),
    );

    expect(dispatcher.hasHooksFor("tool.result")).toBe(true);
    expect(dispatcher.hasHooksFor("tool.call.started")).toBe(true);
  });

  test("runs hooks in order and carries state between runs", async (): Promise<void> => {
    const record = hookRecord("hook_a", "active", ["tool.result"]);
    const dispatcher = createHookDispatcher(
      "acct_1",
      new Map([["tool.result", [record, record]]]),
      {} as Parameters<typeof createHookDispatcher>[2],
    );

    expect(
      await dispatcher.runMutation("tool.call.started", {}),
    ).toBeUndefined();
    expect(await dispatcher.runMutation("tool.result", { output: 1 })).toEqual({
      seen: 1,
    });
    expect(await dispatcher.runMutation("tool.result", { output: 2 })).toEqual({
      seen: 1,
    });
  });
});

describe("conversation files", () => {
  test("lists, strips the prefix and sorts", async (): Promise<void> => {
    nextSandboxResult = {
      ok: true,
      stdout: gzipBase64("./b.txt\tQg==\n./a.txt\tQQ==\nno-tab-line\n"),
      stderr: "",
    };

    expect(await readConversationFiles(WORKSPACE)).toEqual([
      { path: "a.txt", contentBase64: "QQ==" },
      { path: "b.txt", contentBase64: "Qg==" },
    ]);
  });

  test.each([
    {
      name: "stderr",
      result: { ok: false, stdout: "", stderr: "boom" },
      message: "boom",
    },
    {
      name: "empty",
      result: { ok: false, stdout: "", stderr: "" },
      message: "listing failed",
    },
    {
      name: "truncated",
      result: { ok: true, stdout: "", stderr: "", truncated: true },
      message:
        "The folder is over the sandbox's output limit to list in one read.",
    },
  ])("listing fails: $name", async ({ result, message }): Promise<void> => {
    nextSandboxResult = result;

    await expect(readConversationFiles(WORKSPACE)).rejects.toThrow(message);
  });

  test("writing replaces the folder", async (): Promise<void> => {
    nextSandboxResult = { ok: true, stdout: "", stderr: "" };

    await writeConversationFiles(WORKSPACE, [
      { path: "dir/a.txt", contentBase64: "QQ==" },
    ]);

    expect(runSandbox).toHaveBeenCalled();
  });

  test("a failed write throws", async (): Promise<void> => {
    nextSandboxResult = { ok: false, stdout: "", stderr: "disk full" };

    await expect(writeConversationFiles(WORKSPACE, [])).rejects.toThrow(
      "disk full",
    );
  });
});
