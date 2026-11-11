import { afterEach, describe, expect, mock, test } from "bun:test";

interface SentCommand {
  name: string;
  input: Record<string, unknown>;
}

type SendAnswer = Record<string, unknown> | Error;

const sent: SentCommand[] = [];
let answers: SendAnswer[] = [];

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
    const answer = answers.shift() ?? {};
    if (answer instanceof Error) throw answer;

    return answer;
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
await mock.module("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (
    _client: unknown,
    command: SentCommand,
    options: { expiresIn: number },
  ): Promise<string> =>
    `https://signed.test/${String(command.input.Key)}?expires=${options.expiresIn}`,
}));

const adminQuery = mock(async (): Promise<unknown> => true);
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
  adminQuery: adminQuery,
  internal: internalPaths,
}));

const query = mock(async (): Promise<unknown> => "sbx_1");
const mutate = mock(async (): Promise<unknown> => true);
const RUNTIME_PATH = import.meta
  .resolve("../../../../apps/core/src/shared/convex/runtime.ts");
const realRuntime = await import(RUNTIME_PATH);
await mock.module(RUNTIME_PATH, () => ({
  ...realRuntime,
  runtime: { query: query, mutate: mutate },
}));

// Lazy so the module mocks above are in place first.
const s3 = await import("../../../../apps/core/src/shared/s3.ts");
const instances =
  await import("../../../../apps/core/src/shared/convex/sandbox-instances.ts");
const snapshots =
  await import("../../../../apps/core/src/shared/convex/sandbox-snapshots.ts");
const store =
  await import("../../../../apps/core/src/harness/sandbox/instance-store.ts");

afterEach((): void => {
  sent.length = 0;
  answers = [];
  adminQuery.mockReset();
  adminMutation.mockReset();
  query.mockReset();
  mutate.mockReset();
});

function s3Error(name: string): Error {
  const error = new Error(name);
  error.name = name;

  return error;
}

describe("S3 wrappers", () => {
  test.each([
    [
      "with type and executable",
      { contentType: "text/plain", executable: true },
      "0100777",
    ],
    ["without options", {}, "0100666"],
  ])("copyS3Object %s", async (_label, options, permissions): Promise<void> => {
    await s3.copyS3Object("src", "a b/c.txt", "dst", "d/e.txt", options);
    expect(sent[0]?.input.CopySource).toBe("src/a%20b/c.txt");
    expect(sent[0]?.input.Metadata).toMatchObject({
      "file-permissions": permissions,
    });
  });

  test("copyS3Object marks a trailing slash as a directory", async (): Promise<void> => {
    await s3.copyS3Object("src", "dir/", "dst", "dir/");
    expect(sent[0]?.input.Metadata).toMatchObject({
      "file-permissions": "0040777",
    });
  });

  test("copyS3Object rethrows the service error", async (): Promise<void> => {
    answers = [new Error("denied")];
    await expect(s3.copyS3Object("src", "a", "dst", "b")).rejects.toThrow(
      "denied",
    );
  });

  test("deleteS3Object sends bucket and key", async (): Promise<void> => {
    await s3.deleteS3Object("bucket", "key");
    expect(sent[0]?.input).toEqual({ Bucket: "bucket", Key: "key" });
  });

  test("ensureS3DirectoryMarkers writes one marker per parent", async (): Promise<void> => {
    await s3.ensureS3DirectoryMarkers("bucket", "a/b/file.txt");
    expect(sent.map((command) => command.input.Key)).toEqual(["a/", "a/b/"]);
  });

  test.each([
    ["both fields", { ContentLength: 3, ContentType: "text/plain" }],
    ["no fields", {}],
  ])("headS3Object keeps %s", async (_label, answer): Promise<void> => {
    answers = [answer];
    const head = await s3.headS3Object("bucket", "key");
    expect(head?.contentLength).toBe(answer.ContentLength);
  });

  test("headS3Object answers null for a missing key", async (): Promise<void> => {
    answers = [s3Error("NotFound")];
    expect(await s3.headS3Object("bucket", "key")).toBeNull();
  });

  test("headS3Object rethrows anything else", async (): Promise<void> => {
    answers = [s3Error("AccessDenied")];
    await expect(s3.headS3Object("bucket", "key")).rejects.toThrow(
      "AccessDenied",
    );
  });

  test("listS3Prefix walks pages and skips keyless items", async (): Promise<void> => {
    answers = [
      {
        Contents: [{ Key: "a", Size: 1, ETag: '"tag"' }, {}],
        NextContinuationToken: "next",
      },
      { Contents: [{ Key: "b", LastModified: new Date(0) }] },
    ];
    expect(await s3.listS3Prefix("bucket", "p/")).toEqual([
      { key: "a", size: 1, etag: "tag" },
      { key: "b", lastModified: "1970-01-01T00:00:00.000Z" },
    ]);
  });

  test("listS3Prefix rethrows the service error", async (): Promise<void> => {
    answers = [new Error("down")];
    await expect(s3.listS3Prefix("bucket", "p/")).rejects.toThrow("down");
  });

  test.each([
    ["default expiry", {}, 300],
    ["custom expiry", { expiresInSeconds: 60 }, 60],
  ])("putS3ObjectUrl %s", async (_label, options, expiry): Promise<void> => {
    expect(await s3.putS3ObjectUrl("bucket", "key", options)).toContain(
      `expires=${expiry}`,
    );
  });

  test("readS3Text decodes the body", async (): Promise<void> => {
    answers = [
      { Body: { transformToString: async (): Promise<string> => "text" } },
    ];
    expect(await s3.readS3Text("bucket", "key")).toBe("text");
  });

  test.each([
    ["present", { ContentLength: 1 }, true],
    ["absent", s3Error("NoSuchKey"), false],
  ])("s3ObjectExists %s", async (_label, answer, exists): Promise<void> => {
    answers = [answer];
    expect(await s3.s3ObjectExists("bucket", "key")).toBe(exists);
  });

  test("s3ObjectExists rethrows a real failure", async (): Promise<void> => {
    answers = [s3Error("AccessDenied")];
    await expect(s3.s3ObjectExists("bucket", "key")).rejects.toThrow(
      "AccessDenied",
    );
  });

  test.each([
    ["a string", "hello", 5],
    ["bytes", new Uint8Array([1, 2]), 2],
  ])("writeS3Object measures %s", async (_label, body, size): Promise<void> => {
    expect(
      await s3.writeS3Object("bucket", "key", body, { contentType: "x/y" }),
    ).toBe(size);
    expect(sent[0]?.input.ContentType).toBe("x/y");
  });

  test("writeS3Object rethrows the service error", async (): Promise<void> => {
    answers = [new Error("full")];
    await expect(s3.writeS3Object("bucket", "dir/", "")).rejects.toThrow(
      "full",
    );
  });
});

describe("Convex mirrors", () => {
  const specs = { vcpu: 1, memoryMb: 2 };

  test("setSandboxInstanceSpecs swallows a failed write", async (): Promise<void> => {
    adminMutation.mockRejectedValueOnce(new Error("offline"));
    await instances.setSandboxInstanceSpecs("acct", "key", "ext", specs);
    expect(adminMutation).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["changed", true, { observed: true }, true],
    ["unchanged", false, undefined, false],
  ])(
    "setSandboxInstanceStatus %s",
    async (_label, answer, options, want): Promise<void> => {
      adminMutation.mockResolvedValueOnce(answer);
      expect(
        await instances.setSandboxInstanceStatus(
          "acct",
          "key",
          "running",
          options,
        ),
      ).toBe(want);
    },
  );

  test("setSandboxInstanceStatus answers false on failure", async (): Promise<void> => {
    adminMutation.mockRejectedValueOnce(new Error("offline"));
    expect(
      await instances.setSandboxInstanceStatus("acct", "key", "running"),
    ).toBe(false);
  });

  test.each([
    ["true", true, true],
    ["anything else", null, false],
  ])(
    "sandboxInstanceIsControllable on %s",
    async (_label, answer, want): Promise<void> => {
      adminQuery.mockResolvedValueOnce(answer);
      expect(
        await instances.sandboxInstanceIsControllable("acct", "cfg", "key"),
      ).toBe(want);
    },
  );

  test("recordSandboxBurst passes totals and survives failure", async (): Promise<void> => {
    const totals = { vcpuSeconds: 1, gbSeconds: 2 };
    adminMutation.mockResolvedValueOnce(true);
    expect(await instances.recordSandboxBurst("acct", "ext", totals)).toBe(
      true,
    );
    adminMutation.mockRejectedValueOnce(new Error("offline"));
    expect(await instances.recordSandboxBurst("acct", "ext", totals)).toBe(
      false,
    );
  });

  test.each([
    ["with account", "acct", 1],
    ["without account", undefined, 0],
  ])("findSandboxSnapshot %s", async (_label, account, keys): Promise<void> => {
    adminQuery.mockResolvedValueOnce(null);
    expect(await snapshots.findSandboxSnapshot(account, "img")).toBeNull();
    const [, args] = adminQuery.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(Object.keys(args).length).toBe(keys + 1);
  });

  test.each([
    ["with status", "active"],
    ["without status", undefined],
  ] as const)(
    "upsertSandboxSnapshot %s",
    async (_label, status): Promise<void> => {
      await snapshots.upsertSandboxSnapshot({
        accountId: "acct",
        scope: "account",
        name: "snap",
        provider: "lambda",
        baseImage: "default",
        externalImageId: "img",
        ...(status ? { status: status } : {}),
      });
      expect(adminMutation).toHaveBeenCalledTimes(1);
    },
  );

  test("getSandboxExternalId reads the reservation", async (): Promise<void> => {
    query.mockResolvedValueOnce("sbx_1");
    expect(await store.getSandboxExternalId("sandbox", "key")).toBe("sbx_1");
  });

  test("getSandboxReservationRecord reads the record", async (): Promise<void> => {
    const row = { externalId: "sbx_1", claimedAt: 1, expiresAt: 2 };
    query.mockResolvedValueOnce(row);
    expect(await store.getSandboxReservationRecord("sandbox", "key")).toEqual(
      row,
    );
  });

  test.each([
    ["with an account", "acct", true],
    ["without an account", undefined, false],
  ])(
    "claimSandboxInstance %s",
    async (_label, account, want): Promise<void> => {
      mutate.mockResolvedValueOnce(true);
      expect(
        await store.claimSandboxInstance("sandbox", "key", "ext", account),
      ).toBe(want);
    },
  );

  test.each([
    ["with an account", "acct", 1],
    ["without an account", undefined, 0],
  ])(
    "saveSandboxInstance %s",
    async (_label, account, calls): Promise<void> => {
      mutate.mockResolvedValueOnce(undefined);
      await store.saveSandboxInstance("sandbox", "key", "ext", account, 30);
      expect(mutate).toHaveBeenCalledTimes(calls);
    },
  );
});
