import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";

interface SentCommand {
  name: string;
  input: Record<string, unknown>;
}

const sent: SentCommand[] = [];
let listPages: Record<string, unknown>[] = [];

function commandClass(
  name: string,
): new (input: Record<string, unknown>) => SentCommand {
  return class {
    readonly name: string = name;
    readonly input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  };
}

class FakeS3Client {
  async send(command: SentCommand): Promise<Record<string, unknown>> {
    sent.push(command);
    if (command.name === "list") return listPages.shift() ?? {};

    return {};
  }
}

await mock.module("@aws-sdk/client-s3", () => ({
  S3Client: FakeS3Client,
  CopyObjectCommand: commandClass("copy"),
  DeleteObjectCommand: commandClass("delete"),
  DeleteObjectsCommand: commandClass("deleteMany"),
  GetObjectCommand: commandClass("get"),
  HeadObjectCommand: commandClass("head"),
  ListObjectsV2Command: commandClass("list"),
  PutObjectCommand: commandClass("put"),
}));

const adminMutation = mock(async (): Promise<unknown> => true);
const CLIENT_PATH = import.meta
  .resolve("../../../../apps/core/src/shared/convex/client.ts");
const realClient = await import(CLIENT_PATH);
const internalPaths = new Proxy(
  {},
  {
    get: (_target: object, first: string): object =>
      new Proxy(
        {},
        {
          get: (_inner: object, second: string): object =>
            new Proxy(
              {},
              {
                get: (_leaf: object, third: string): string =>
                  `${first}.${second}.${third}`,
              },
            ),
        },
      ),
  },
);
await mock.module(CLIENT_PATH, () => ({
  ...realClient,
  adminMutation: adminMutation,
  internal: internalPaths,
}));

const query = mock(async (): Promise<unknown> => null);
const mutate = mock(async (): Promise<unknown> => false);
const RUNTIME_PATH = import.meta
  .resolve("../../../../apps/core/src/shared/convex/runtime.ts");
const realRuntime = await import(RUNTIME_PATH);
await mock.module(RUNTIME_PATH, () => ({
  ...realRuntime,
  runtime: { query: query, mutate: mutate },
}));

// Lazy so the module mocks above are in place first.
const { createIncomingEventRouter } =
  await import("../../../../apps/core/src/harness/integrations.ts");
const { setStorageForTests } =
  await import("../../../../apps/core/src/shared/storage.ts");
const { coreRequest } =
  await import("../../../../apps/core/tests/helpers/http.ts");

const SECRET = "partition-secret";
const BUCKET = "managed-bucket";
const previousBucket = process.env["FILESYSTEM_BUCKET_NAME"];
process.env["FILESYSTEM_BUCKET_NAME"] = BUCKET;
process.env["CONVEX_URL"] ??= "https://convex.test";
process.env["CONVEX_DEPLOY_KEY"] ??= "prod:test|key";

afterEach((): void => {
  sent.length = 0;
  listPages = [];
  query.mockClear();
  mutate.mockClear();
  adminMutation.mockClear();
  setStorageForTests(null);
});

function agentConfig(partition: unknown): Record<string, unknown> {
  return {
    channels: {
      github: {
        webhookSecret: SECRET,
        appId: "app-1",
        privateKey: "key",
        ...(partition === undefined ? {} : { partition: partition }),
      },
    },
    workspaces: [
      { workspaceId: "ws_conversation" },
      { workspaceId: "ws_shared" },
      { workspaceId: "ws_missing" },
    ],
  };
}

function install(lookups: string[]): void {
  setStorageForTests({
    sandboxConfigs: { list: async (): Promise<unknown[]> => [] },
    workspaceConfigs: {
      getById: async (_accountId: string, workspaceId: string) => {
        lookups.push(workspaceId);
        if (workspaceId === "ws_missing") return null;

        return {
          workspaceId: workspaceId,
          config: {
            isolation:
              workspaceId === "ws_conversation" ? "conversation" : "agent",
          },
        };
      },
    },
  } as never);
}

async function closeIssue(
  config: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({
    action: "closed",
    repository: {
      full_name: "owner/repo",
      name: "repo",
      owner: { login: "owner" },
    },
    issue: { number: 7, title: "Bug", body: "Details" },
    installation: { id: 99 },
  });
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  const pending: Promise<unknown>[] = [];
  const agent = {
    accountId: "acct_test",
    agentId: "agent_test",
    name: "Cleanup",
    status: "active" as const,
    config: config,
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
  };
  const router = createIncomingEventRouter({
    accountLoader: async () =>
      ({
        accountId: "acct_test",
        username: "acct",
        description: "",
        secretHash: "hash",
        status: "active",
        config: {},
        createdAt: "2026-04-24T00:00:00.000Z",
        updatedAt: "2026-04-24T00:00:00.000Z",
      }) as never,
    agentLoader: async () => agent as never,
    agentLister: async () => [agent as never],
    deploymentLoader: async () => null,
    channelRecordLoader: async () => null,
    waitUntil: (promise): void => {
      pending.push(Promise.resolve(promise));
    },
  });
  const response = await router(
    coreRequest(
      "POST",
      "/v1/webhooks/acct_test/github",
      {
        "x-github-event": "issues",
        "x-github-delivery": "delivery-closed",
        "x-hub-signature-256": signature,
      },
      body,
    ),
    {
      handleDirectRequest: async (): Promise<Response> => new Response("ok"),
      handleChannelRequest: async (): Promise<void> => {},
    },
  );
  await Promise.all(pending);

  return { status: response.status, body: await response.text() };
}

describe("channel partition cleanup", (): void => {
  test("a closed issue deletes the conversation workspace prefix and skips the others", async (): Promise<void> => {
    const lookups: string[] = [];
    install(lookups);
    listPages = [
      { Contents: [{ Key: "a/1" }, { Key: "a/2" }], IsTruncated: false },
    ];

    const result = await closeIssue(
      agentConfig({ by: "conversation", alias: "issue" }),
    );

    expect(result.status).toBe(200);
    expect(lookups).toEqual(["ws_conversation", "ws_shared", "ws_missing"]);
    const listed = sent.filter((command) => command.name === "list");
    const deleted = sent.filter((command) => command.name === "deleteMany");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.input["Bucket"]).toBe(BUCKET);
    expect(String(listed[0]?.input["Prefix"])).toMatch(/\/$/);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.input["Delete"]).toEqual({
      Objects: [{ Key: "a/1" }, { Key: "a/2" }],
      Quiet: true,
    });
    expect(adminMutation).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalled();
  });

  test("a shared partition cleans nothing", async (): Promise<void> => {
    const lookups: string[] = [];
    install(lookups);

    const result = await closeIssue(agentConfig({ by: "shared" }));

    expect(result.status).toBe(200);
    expect(lookups).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("a channel with no partition cleans nothing", async (): Promise<void> => {
    const lookups: string[] = [];
    install(lookups);

    await closeIssue(agentConfig(undefined));

    expect(lookups).toEqual([]);
    expect(sent).toEqual([]);
  });
});

process.on("exit", (): void => {
  if (previousBucket === undefined)
    delete process.env["FILESYSTEM_BUCKET_NAME"];
  else process.env["FILESYSTEM_BUCKET_NAME"] = previousBucket;
});
