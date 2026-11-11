import { afterEach, describe, expect, mock, test } from "bun:test";

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
const { deleteAccountRuntimeData } =
  await import("../../../../apps/core/src/accounts/cleanup.ts");
const { setStorageForTests } =
  await import("../../../../apps/core/src/shared/storage.ts");

process.env["CONVEX_URL"] ??= "https://convex.test";
process.env["CONVEX_DEPLOY_KEY"] ??= "prod:test|key";
const previousBucket = process.env["FILESYSTEM_BUCKET_NAME"];

const ACCOUNT = {
  accountId: "acct_files",
  username: "files",
  secretHash: "hash",
  status: "disabled" as const,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

function install(workspaces: unknown[]): void {
  setStorageForTests({
    sandboxConfigs: {
      list: async (): Promise<unknown[]> => [],
      removeAllForAccount: async (): Promise<number> => 0,
    },
    workspaceConfigs: {
      list: async (): Promise<unknown[]> => workspaces,
      removeAllForAccount: async (): Promise<number> => 0,
      mintR2Credentials: async (): Promise<Record<string, string>> => ({
        accessKeyId: "id",
        secretAccessKey: "secret",
        sessionToken: "token",
        expiration: "2099-01-01T00:00:00.000Z",
      }),
    },
  } as never);
  query.mockImplementation(async () => ({
    page: [],
    cursor: null,
    isDone: true,
  }));
  mutate.mockImplementation(async () => ({
    conversationsDeleted: 0,
    processedEventsDeleted: 0,
    asyncAgentResultDeleted: 0,
    asyncToolResultDeleted: 0,
    sandboxReservationDeleted: 0,
    totalDeleted: 0,
  }));
}

afterEach((): void => {
  sent.length = 0;
  listPages = [];
  query.mockReset();
  mutate.mockReset();
  setStorageForTests(null);
  if (previousBucket === undefined)
    delete process.env["FILESYSTEM_BUCKET_NAME"];
  else process.env["FILESYSTEM_BUCKET_NAME"] = previousBucket;
});

describe("account workspace filesystems", (): void => {
  test("a workspace on its own bucket is emptied under its own prefix", async (): Promise<void> => {
    delete process.env["FILESYSTEM_BUCKET_NAME"];
    install([
      {
        workspaceId: "ws_own",
        config: {
          storage: {
            bucket: "own-bucket",
            prefix: "tenant/",
            endpoint:
              "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
            region: "auto",
            auth: { type: "r2" },
            owner: { accountId: "acct_files", workspaceId: "ws_own" },
          },
        },
      },
    ]);
    listPages = [{ Contents: [{ Key: "tenant/a" }, { Key: "tenant/b" }] }];

    const summary = await deleteAccountRuntimeData(ACCOUNT as never);

    expect(summary.filesystemObjectsDeleted).toBe(2);
    const listed = sent.find((command) => command.name === "list");
    expect(listed?.input["Bucket"]).toBe("own-bucket");
    expect(String(listed?.input["Prefix"])).toMatch(/^tenant\//);
  });

  test("a named bucket without its own credentials is refused before any delete", async (): Promise<void> => {
    delete process.env["FILESYSTEM_BUCKET_NAME"];
    install([
      {
        workspaceId: "ws_bare",
        config: { storage: { bucket: "own-bucket", prefix: "tenant/" } },
      },
    ]);

    await expect(deleteAccountRuntimeData(ACCOUNT as never)).rejects.toThrow(
      "a named bucket is only reached with its own credentials",
    );
    expect(sent.filter((command) => command.name !== "list")).toEqual([]);
  });

  test("a managed workspace is emptied in the platform bucket", async (): Promise<void> => {
    process.env["FILESYSTEM_BUCKET_NAME"] = "platform-bucket";
    install([{ workspaceId: "ws_managed", config: {} }]);
    listPages = [{ Contents: [{ Key: "x" }] }];

    const summary = await deleteAccountRuntimeData(ACCOUNT as never);

    expect(summary.filesystemObjectsDeleted).toBe(1);
    expect(
      sent.find((command) => command.name === "list")?.input["Bucket"],
    ).toBe("platform-bucket");
  });

  test("a managed workspace with no platform bucket has nothing to delete", async (): Promise<void> => {
    delete process.env["FILESYSTEM_BUCKET_NAME"];
    install([{ workspaceId: "ws_managed", config: {} }]);

    const summary = await deleteAccountRuntimeData(ACCOUNT as never);

    expect(summary.filesystemObjectsDeleted).toBe(0);
    expect(sent.filter((command) => command.name === "list")).toEqual([]);
  });
});
