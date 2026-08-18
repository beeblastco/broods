/**
 * workdir (`sandbox` provider) executor unit/contract tests.
 * Drive the REAL @mv37/workdir SDK with a mocked global fetch so the SDK's own
 * request serialization + response parsing are exercised against the documented
 * wire shapes (docs/API.md) — create/exec/delete, network + S3-mount mapping,
 * persistent reserve/reconnect, background jobs, snapshot/suspend/resume — with
 * no real workdir host. A separate *.integration.test.ts hits a live server.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Captured before any test mutates it, so we can restore the native fetch and
// not leak the mock into other test files (e.g. the live integration test).
const realFetch = globalThis.fetch;

interface FetchCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

let fetchCalls: FetchCall[] = [];
// GET /v1/sandboxes/:id returns this state (drives reconnect/resume).
let reconnectState = "running";
let execResult = { exit_code: 0, stdout: "workdir ok\n", stderr: "" };

// The documented sandbox object shape (docs/API.md:124-152), trimmed.
function sandboxObject(id: string, state: string): Record<string, unknown> {
  return {
    id: id,
    runtime: "firecracker",
    image: "base",
    state: state,
    resources: { cpu: "1 shared vCPU", memory_mb: 2048, disk_gb: 8 },
    boot_path: "hot_pool",
    urls: { ports: {} },
    mounts: [],
    volumes: [],
    network: { egress: "default" },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: async () => (payload === undefined ? "" : JSON.stringify(payload)),
  } as unknown as Response;
}

const fetchMock = mock(
  async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const full = String(url);
    const path = full.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    fetchCalls.push({
      method: method,
      path: path,
      body: body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });

    if (method === "POST" && path === "/v1/sandboxes")
      return jsonResponse(sandboxObject("sbx_new", "running"), 201);
    if (method === "GET" && /^\/v1\/sandboxes\/[^/]+$/.test(path)) {
      return jsonResponse(
        sandboxObject(path.split("/").pop()!, reconnectState),
      );
    }
    if (method === "POST" && path.endsWith("/exec"))
      return jsonResponse(execResult);
    if (method === "POST" && path.endsWith("/snapshot"))
      return jsonResponse({ id: "snap_1", image_id: "img_1" });
    if (method === "POST" && path.endsWith("/pause"))
      return jsonResponse(sandboxObject("sbx_stored", "stopped"));
    if (method === "POST" && path.endsWith("/resume"))
      return jsonResponse(sandboxObject("sbx_stored", "running"));
    if (method === "DELETE") return jsonResponse({});

    return jsonResponse({ error: { code: "not_found", message: path } }, 404);
  },
);

let storedSandboxExternalId: string | null = null;
const getSandboxExternalIdMock = mock(
  async (_provider: string, _key: string) => storedSandboxExternalId,
);
const claimSandboxInstanceMock = mock(
  async (_provider: string, _key: string, externalId: string) => {
    storedSandboxExternalId = externalId;

    return true;
  },
);
const saveSandboxInstanceMock = mock(
  async (_provider: string, _key: string, externalId: string) => {
    storedSandboxExternalId = externalId;
  },
);
const deleteSandboxInstanceMock = mock(async () => {
  storedSandboxExternalId = null;
});
const upsertSandboxInstanceMock = mock(async () => {});
// Epoch ms the stored reservation was claimed; drives the max-lifetime check.
// Defaults to "just now" so the reserved-sandbox tests are not accidentally expired.
let storedReservedAt = Date.now();
const getSandboxReservationRecordMock = mock(
  async (
    _provider: string,
    _key: string,
  ): Promise<{ externalId: string; claimedAt: number } | null> =>
    storedSandboxExternalId === null
      ? null
      : { externalId: storedSandboxExternalId, claimedAt: storedReservedAt },
);

mock.module("../src/harness/sandbox/instance-store.ts", () => ({
  getSandboxExternalId: getSandboxExternalIdMock,
  getSandboxReservationRecord: getSandboxReservationRecordMock,
  claimSandboxInstance: claimSandboxInstanceMock,
  saveSandboxInstance: saveSandboxInstanceMock,
  deleteSandboxInstance: deleteSandboxInstanceMock,
}));
// mock.module replaces the whole module, so every export the executor's own imports
// reach for has to be here — the sandbox index pulls the microvm executor in too, and
// a missing name is a SyntaxError at import time, not an undefined at call time.
mock.module("../src/shared/convex/sandbox-instances.ts", () => ({
  upsertSandboxInstance: upsertSandboxInstanceMock,
  setSandboxInstanceStatus: mock(async (): Promise<void> => {}),
  sandboxInstanceIsControllable: mock(async (): Promise<boolean> => true),
  removeSandboxInstance: mock(async (): Promise<void> => {}),
}));

// Assume-role S3 mount path: stub STS so it returns fixed temporary credentials
// and capture the scoped session policy the executor builds.
let lastAssumeRoleInput: Record<string, unknown> | undefined;
const assumeRoleSendMock = mock(async () => ({
  Credentials: {
    AccessKeyId: "ASIA_TEMP",
    SecretAccessKey: "temp-secret",
    SessionToken: "temp-token",
  },
}));
mock.module("@aws-sdk/client-sts", () => ({
  STSClient: class {
    send = assumeRoleSendMock;
  },
  AssumeRoleCommand: class {
    constructor(input: Record<string, unknown>) {
      lastAssumeRoleInput = input;
    }
  },
}));

const NS = "fs-0123456789abcdef0123456789abcdef01234567";
const BASE = "https://workdir.test";

function execCalls(): FetchCall[] {
  return fetchCalls.filter((c) => c.path.endsWith("/exec"));
}

// The parsed body of the most recent create call.
function createBody(): Record<string, unknown> {
  const create = fetchCalls.find(
    (c) => c.method === "POST" && c.path === "/v1/sandboxes",
  );

  return (create?.body ?? {}) as Record<string, unknown>;
}

async function newExecutor(config: Record<string, unknown>) {
  const { WorkdirSandboxExecutor } =
    await import("../src/harness/sandbox/workdir-executor.ts");
  const options =
    config.options &&
    typeof config.options === "object" &&
    !Array.isArray(config.options)
      ? { ...(config.options as Record<string, unknown>) }
      : undefined;
  const safeConfig =
    options?.workdirUrl && !options.apiKey
      ? { ...config, options: { ...options, apiKey: "tenant-workdir-key" } }
      : config;

  return new WorkdirSandboxExecutor(safeConfig as never);
}

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchCalls = [];
  reconnectState = "running";
  execResult = { exit_code: 0, stdout: "workdir ok\n", stderr: "" };
  storedSandboxExternalId = null;
  storedReservedAt = Date.now();
  process.env.AWS_REGION = "us-east-1";
  process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
  delete process.env.WORKDIR_URL;
  delete process.env.WORKDIR_API_KEY;
  // Default to the static-key (declarative) mount path; role tests opt in.
  delete process.env.SANDBOX_MOUNT_ROLE_ARN;
  lastAssumeRoleInput = undefined;
  fetchMock.mockClear();
  assumeRoleSendMock.mockClear();
  getSandboxExternalIdMock.mockClear();
  claimSandboxInstanceMock.mockClear();
  saveSandboxInstanceMock.mockClear();
  deleteSandboxInstanceMock.mockClear();
  upsertSandboxInstanceMock.mockClear();
  getSandboxReservationRecordMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createSandboxExecutor (sandbox provider)", () => {
  it("creates the WorkdirSandboxExecutor for provider 'sandbox'", () => {
    process.env.WORKDIR_URL = BASE;
    const {
      createSandboxExecutor,
    } = require("../src/harness/sandbox/index.ts");
    expect(
      createSandboxExecutor({ provider: "sandbox" }).constructor.name,
    ).toBe("WorkdirSandboxExecutor");
  });

  it("throws when no workdir base URL is configured", () => {
    const {
      createSandboxExecutor,
    } = require("../src/harness/sandbox/index.ts");
    expect(() => createSandboxExecutor({ provider: "sandbox" })).toThrow(
      /WORKDIR_URL/,
    );
  });

  it("requires a tenant API key when a tenant workdir URL is configured", async () => {
    const { WorkdirSandboxExecutor } =
      await import("../src/harness/sandbox/workdir-executor.ts");
    expect(
      () =>
        new WorkdirSandboxExecutor({
          provider: "sandbox",
          options: { workdirUrl: BASE },
        } as never),
    ).toThrow("config.options.apiKey is required");
  });

  it("rejects unsafe tenant workdir URLs", async () => {
    const { WorkdirSandboxExecutor } =
      await import("../src/harness/sandbox/workdir-executor.ts");
    expect(
      () =>
        new WorkdirSandboxExecutor({
          provider: "sandbox",
          options: {
            workdirUrl: "http://127.0.0.1:7777",
            apiKey: "tenant-key",
          },
        } as never),
    ).toThrow("config.options.workdirUrl must use https");
  });
});

describe("WorkdirSandboxExecutor.run", () => {
  it("creates an ephemeral sandbox, execs in the workspace cwd, then deletes it", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE },
    });

    const result = await executor.run({
      code: "echo hi && ls",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    // exit_code:0 from the documented ExecResult, parsed by the real SDK.
    expect(result).toMatchObject({
      ok: true,
      provider: "sandbox",
      stdout: "workdir ok\n",
      exitCode: 0,
    });
    expect(
      fetchCalls.find((c) => c.method === "POST" && c.path === "/v1/sandboxes"),
    ).toBeTruthy();
    expect(execCalls()[0]!.body).toMatchObject({
      cmd: "echo hi && ls",
      cwd: `/mnt/workspaces/${NS}`,
    });
    // Ephemeral sandboxes are torn down after the call.
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("reads the base URL and bearer key from env when options omit them", async () => {
    process.env.WORKDIR_URL = BASE;
    process.env.WORKDIR_API_KEY = "sk_test";
    const executor = await newExecutor({ provider: "sandbox" });

    await executor.run({
      code: "echo ok",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    const create = fetchCalls.find((c) => c.path === "/v1/sandboxes")!;
    expect(create.headers.Authorization).toBe("Bearer sk_test");
  });

  it("omits cwd for stateless execs without a workspace namespace", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE },
    });

    await executor.run({
      code: "echo ok",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(execCalls()[0]!.body).toMatchObject({ cmd: "echo ok" });
    expect(execCalls()[0]!.body).not.toHaveProperty("cwd");
  });

  it("maps the predefined resource knobs onto the SDK's snake_case wire shape", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE, cpu: 2, memoryMb: 4096, diskGb: 16 },
    });
    await executor.run({
      code: "echo ok",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    // The SDK converts memoryMb -> memory_mb, diskGb -> disk_gb.
    expect(createBody().resources).toEqual({
      cpu: 2,
      memory_mb: 4096,
      disk_gb: 16,
    });
  });

  it("derives create-time resources from the predefined size (medium)", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      size: "medium",
      options: { workdirUrl: BASE },
    });
    await executor.run({
      code: "echo ok",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(createBody().resources).toEqual({
      cpu: 2,
      memory_mb: 4096,
      disk_gb: 16,
    });
  });

  it("clamps the size vcpu to workdir's allowed set (tiny 0.25 -> 0.5) and lets explicit options win", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      size: "tiny",
      options: { workdirUrl: BASE, memoryMb: 2048 },
    });
    await executor.run({
      code: "echo ok",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(createBody().resources).toEqual({
      cpu: 0.5,
      memory_mb: 2048,
      disk_gb: 8,
    });
  });

  it("launches from the config snapshot pin, preferring it over the options.image alias", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      snapshot: "img_curated",
      options: { workdirUrl: BASE, image: "img_legacy" },
    });
    await executor.run({
      code: "echo ok",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(createBody().image).toBe("img_curated");
  });

  it("maps network modes onto workdir egress policy", async () => {
    const allowAll = await newExecutor({
      provider: "sandbox",
      network: { mode: "allow-all" },
      options: { workdirUrl: BASE },
    });
    await allowAll.run({
      code: "echo ok",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect((createBody().startup as Record<string, unknown>).network).toEqual({
      egress: "default",
    });

    fetchCalls = [];
    const denyAll = await newExecutor({
      provider: "sandbox",
      network: { mode: "deny-all" },
      options: { workdirUrl: BASE },
    });
    await denyAll.run({
      code: "echo ok",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect((createBody().startup as Record<string, unknown>).network).toEqual({
      egress: "none",
    });

    fetchCalls = [];
    const restricted = await newExecutor({
      provider: "sandbox",
      network: {
        mode: "restricted",
        allowDomains: ["api.example.com"],
        allowCidrs: ["10.0.0.0/8"],
      },
      options: { workdirUrl: BASE },
    });
    await restricted.run({
      code: "echo ok",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect((createBody().startup as Record<string, unknown>).network).toEqual({
      egress: "allowlist",
      allow: [{ type: "domain", value: "api.example.com" }, "10.0.0.0/8"],
    });
  });

  it("declares a top-level S3 mount and references AWS secret env names (not inline creds)", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: {
        workdirUrl: BASE,
        mountAwsS3Buckets: true,
        workspaceRoot: "/mnt/workspaces",
      },
    });

    const result = await executor.run({
      code: "ls",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "sandbox" });
    const body = createBody();
    // mounts[] is top-level (sibling of startup), with no credentials in the spec.
    expect(body.mounts).toEqual([
      {
        type: "s3",
        bucket: "workspace-bucket",
        mount_path: `/mnt/workspaces/${NS}`,
        // workdir defaults S3 mounts to read-only; the workspace mount opts out.
        read_only: false,
        prefix: `${NS}/`,
        region: "us-east-1",
      },
    ]);
    // Creds come from the guest secret env: mount-s3 reads spec.secret_env, which
    // workdir populates from these named org secrets at boot.
    expect((body.startup as Record<string, unknown>).secrets).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]);
    expect(JSON.stringify(body)).not.toContain("startup.env");
  });

  it("rejects an S3 mount without a namespace", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE, mountAwsS3Buckets: true },
    });

    await expect(
      executor.run({ code: "ls", timeoutSeconds: 30, outputLimitBytes: 4096 }),
    ).rejects.toThrow(
      "workdir AWS S3 workspace mount requires a workspace namespace",
    );
  });

  it("mounts S3 via exec with scoped assume-role credentials when SANDBOX_MOUNT_ROLE_ARN is set", async () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN =
      "arn:aws:iam::123456789012:role/sandbox-mount";
    const executor = await newExecutor({
      provider: "sandbox",
      options: {
        workdirUrl: BASE,
        mountAwsS3Buckets: true,
        workspaceRoot: "/mnt/workspaces",
      },
    });

    const result = await executor.run({
      code: "ls",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "sandbox" });
    // Role mode: the host does NOT mount declaratively (no per-namespace creds in
    // the org secret store), so there is no mounts[] / startup.secrets on create.
    const body = createBody();
    expect(body.mounts).toBeUndefined();
    expect(
      (body.startup as Record<string, unknown> | undefined)?.secrets,
    ).toBeUndefined();

    // Instead the workspace is mounted via exec with short-lived, namespace-scoped
    // credentials (including the session token) handed in as per-call env.
    const mount = execCalls().find((c) =>
      String(c.body?.cmd).includes("mount-s3"),
    );
    expect(mount).toBeTruthy();
    expect(String(mount!.body?.cmd)).toContain(`'--prefix' '${NS}/'`);
    expect(String(mount!.body?.cmd)).toContain("'--allow-delete'");
    expect(String(mount!.body?.cmd)).toContain("'--allow-overwrite'");
    // The guard clears a wedged FUSE endpoint before retaking the path, and stamps
    // the mount so a later call can tell the credentials have aged out.
    expect(String(mount!.body?.cmd)).toContain("fusermount -u");
    expect(String(mount!.body?.cmd)).toContain("umount -l");
    expect(String(mount!.body?.cmd)).toContain(".mounted-at");
    expect(String(mount!.body?.cmd)).toContain(`-ge ${45 * 60}`);
    // The stamp sits on disk the agent can write, so a non-numeric value must fall
    // back to "unknown age" instead of reaching the arithmetic, which would abort
    // the mount and strand the workspace.
    expect(String(mount!.body?.cmd)).toContain(
      `case "$stamp" in '' | *[!0-9]*) stamp=0 ;; esac;`,
    );
    expect(mount!.body?.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "ASIA_TEMP",
      AWS_SECRET_ACCESS_KEY: "temp-secret",
      AWS_SESSION_TOKEN: "temp-token",
    });
    // The assumed session is scoped to this namespace's bucket prefix only.
    expect(String(lastAssumeRoleInput?.Policy)).toContain(
      `workspace-bucket/${NS}/`,
    );
  });

  it("mounts a managed workspace (no storage block) whenever the run has a namespace", async () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN =
      "arn:aws:iam::123456789012:role/sandbox-mount";
    // No `storage` and no `mountAwsS3Buckets`: the managed-workspace shape.
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE, workspaceRoot: "/mnt/workspaces" },
    });

    const result = await executor.run({
      code: "ls",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "sandbox" });
    const mount = execCalls().find((c) =>
      String(c.body?.cmd).includes("mount-s3"),
    );
    expect(mount).toBeTruthy();
    expect(String(mount!.body?.cmd)).toContain(`'--prefix' '${NS}/'`);
  });

  it("declares a managed-workspace mount without a role (no storage, no opt-in flag)", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE, workspaceRoot: "/mnt/workspaces" },
    });

    await executor.run({
      code: "ls",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(createBody().mounts).toEqual([
      {
        type: "s3",
        bucket: "workspace-bucket",
        mount_path: `/mnt/workspaces/${NS}`,
        read_only: false,
        prefix: `${NS}/`,
        region: "us-east-1",
      },
    ]);
  });

  it("skips mounting for namespace-less runs when nothing opts in", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE },
    });

    const result = await executor.run({
      code: "ls",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "sandbox" });
    expect(createBody().mounts).toBeUndefined();
    expect(
      execCalls().some((c) => String(c.body?.cmd).includes("mount-s3")),
    ).toBe(false);
  });

  it("requires a namespace for the assume-role S3 mount", async () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN =
      "arn:aws:iam::123456789012:role/sandbox-mount";
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE, mountAwsS3Buckets: true },
    });

    await expect(
      executor.run({ code: "ls", timeoutSeconds: 30, outputLimitBytes: 4096 }),
    ).rejects.toThrow(
      "workdir AWS S3 workspace mount requires a workspace namespace",
    );
  });

  it("mounts a bring-your-own bucket via exec using the workspace storage assume-role", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE, workspaceRoot: "/mnt/workspaces" },
      // Storage identity drives the mount — no SANDBOX_MOUNT_ROLE_ARN, no option flag.
      storage: {
        provider: "s3",
        bucket: "acme-bucket",
        region: "us-west-2",
        auth: {
          type: "assumeRole",
          roleArn: "arn:aws:iam::222222222222:role/byo",
          externalId: "ext-7",
        },
      },
    });

    const result = await executor.run({
      code: "ls",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "sandbox" });
    // No declarative mount; the developer's bucket is mounted via exec.
    expect(createBody().mounts).toBeUndefined();
    const mount = execCalls().find((c) =>
      String(c.body?.cmd).includes("mount-s3"),
    );
    expect(mount).toBeTruthy();
    expect(String(mount!.body?.cmd)).toContain("'acme-bucket'");
    // Whole-bucket BYO mount (no prefix configured) omits --prefix.
    expect(String(mount!.body?.cmd)).not.toContain("--prefix");
    expect(mount!.body?.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "ASIA_TEMP",
      AWS_SESSION_TOKEN: "temp-token",
    });
    // The developer's role is assumed with their ExternalId.
    expect(lastAssumeRoleInput?.RoleArn).toBe(
      "arn:aws:iam::222222222222:role/byo",
    );
    expect(lastAssumeRoleInput?.ExternalId).toBe("ext-7");
  });

  it("reserves a persistent sandbox, reconnects by stored id, and never deletes it", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      options: { workdirUrl: BASE },
    });

    // First call: no stored id => create + claim.
    await executor.run({
      code: "echo one",
      reservationKey: "tool:acct_1",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(claimSandboxInstanceMock).toHaveBeenCalledWith(
      "sandbox",
      "tool:acct_1",
      "sbx_new",
      undefined,
    );
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);

    // Second call: stored + idled => GET then resume, no new create.
    fetchCalls = [];
    reconnectState = "stopped";
    await executor.run({
      code: "echo two",
      reservationKey: "tool:acct_1",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(
      fetchCalls.some((c) => c.method === "POST" && c.path === "/v1/sandboxes"),
    ).toBe(false);
    expect(fetchCalls.some((c) => c.path.endsWith("/resume"))).toBe(true);
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("retires a reserved sandbox that outlived lifecycle.maxLifetimeSeconds", async (): Promise<void> => {
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      lifecycle: { idleTimeoutSeconds: 120, maxLifetimeSeconds: 900 },
      options: { workdirUrl: BASE },
    });

    storedSandboxExternalId = "sbx_stored";
    storedReservedAt = Date.now() - 901_000;
    await executor.run({
      code: "echo expired",
      reservationKey: "tool:acct_1",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(true);
    expect(
      fetchCalls.some((c) => c.method === "POST" && c.path === "/v1/sandboxes"),
    ).toBe(true);
    expect(fetchCalls.some((c) => c.path.endsWith("/resume"))).toBe(false);
  });

  it("keeps a reserved sandbox that is still inside its max lifetime", async (): Promise<void> => {
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      lifecycle: { idleTimeoutSeconds: 120, maxLifetimeSeconds: 900 },
      options: { workdirUrl: BASE },
    });

    storedSandboxExternalId = "sbx_stored";
    storedReservedAt = Date.now() - 60_000;
    reconnectState = "stopped";
    await executor.run({
      code: "echo fresh",
      reservationKey: "tool:acct_1",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
    expect(
      fetchCalls.some((c) => c.method === "POST" && c.path === "/v1/sandboxes"),
    ).toBe(false);
    expect(fetchCalls.some((c) => c.path.endsWith("/resume"))).toBe(true);
  });

  it("never expires a reserved sandbox when no max lifetime is configured", async (): Promise<void> => {
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      options: { workdirUrl: BASE },
    });

    storedSandboxExternalId = "sbx_stored";
    storedReservedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await executor.run({
      code: "echo ancient",
      reservationKey: "tool:acct_1",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    // A month-old reservation is still reused, because no max lifetime bounds it.
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
    expect(
      fetchCalls.some((c) => c.method === "POST" && c.path === "/v1/sandboxes"),
    ).toBe(false);
  });

  it("clamps auto_stop_seconds into the range workdir accepts", async (): Promise<void> => {
    // The account-facing idle timeout allows up to a week; workdir 400s anything
    // over an hour, which would fail every create rather than degrade.
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      lifecycle: { idleTimeoutSeconds: 7 * 24 * 60 * 60 },
      options: { workdirUrl: BASE },
    });

    await executor.run({
      code: "echo clamp",
      reservationKey: "tool:acct_1",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(createBody().auto_stop_seconds).toBe(60 * 60);
  });

  it("runs onCreate/onResume lifecycle hooks for a persistent sandbox", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      onCreate: ["echo create > hook.txt"],
      onResume: ["echo resume >> hook.txt"],
      options: { workdirUrl: BASE },
    });

    await executor.run({
      code: "cat hook.txt",
      reservationKey: "tool:acct_1",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(
      execCalls().find((c) =>
        String(c.body?.cmd).includes("echo create > hook.txt"),
      ),
    ).toBeTruthy();
  });
});

describe("WorkdirSandboxExecutor background jobs", () => {
  it("launches a detached job through exec for a persistent sandbox", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      options: { workdirUrl: BASE },
    });

    const handle = await executor.runBackground({
      code: "node runner.js",
      reservationKey: "tool:acct_1",
      jobId: "job_test",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(handle).toEqual({ jobId: "job_test" });
    const launch = execCalls().find((c) =>
      String(c.body?.cmd).includes("setsid bash -c"),
    );
    expect(launch).toBeTruthy();
    expect(String(launch!.body?.cmd)).toContain("job_test.running");
  });

  it("requires a persistent reservation for background jobs", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE },
    });
    await expect(
      executor.runBackground({
        code: "x",
        timeoutSeconds: 30,
        outputLimitBytes: 4096,
      }),
    ).rejects.toThrow(
      "background jobs require a persistent workdir sandbox reservation key",
    );
  });
});

describe("WorkdirSandboxExecutor lifecycle", () => {
  it("runs lifecycle hooks when Harness acquires or resumes a reservation", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      onCreate: ["echo create > hook.txt"],
      onResume: ["echo resume >> hook.txt"],
      options: { workdirUrl: BASE },
    });

    await executor.acquireHarnessReservation({
      reservationKey: "harness:session-1",
    });
    expect(
      execCalls().some((call) =>
        String(call.body?.cmd).includes("echo create > hook.txt"),
      ),
    ).toBe(true);

    fetchCalls = [];
    await executor.resumeHarnessReservation({
      reservationKey: "harness:session-1",
    });
    expect(
      execCalls().some((call) =>
        String(call.body?.cmd).includes("echo resume >> hook.txt"),
      ),
    ).toBe(true);
  });

  it("reports whether a Harness reservation won the existing atomic create claim", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      options: { workdirUrl: BASE },
    });

    const first = await executor.acquireHarnessReservation({
      reservationKey: "harness:session-1",
    });
    expect(first.sandbox.id).toBe("sbx_new");
    expect(first.isFirstCreate).toBe(true);

    fetchCalls = [];
    const existing = await executor.acquireHarnessReservation({
      reservationKey: "harness:session-1",
    });
    expect(existing.sandbox.id).toBe("sbx_new");
    expect(existing.isFirstCreate).toBe(false);
    expect(
      fetchCalls.some(
        (call) => call.method === "POST" && call.path === "/v1/sandboxes",
      ),
    ).toBe(false);
  });

  it("cleans up a newly claimed reservation when post-claim persistence fails", async () => {
    upsertSandboxInstanceMock.mockImplementationOnce(async () => {
      throw new Error("post-claim persistence failed");
    });
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      options: { workdirUrl: BASE },
    });

    await expect(
      executor.acquireHarnessReservation({
        reservationKey: "harness:session-1",
      }),
    ).rejects.toThrow("post-claim persistence failed");

    expect(
      fetchCalls.some(
        (call) =>
          call.method === "DELETE" && call.path === "/v1/sandboxes/sbx_new",
      ),
    ).toBe(true);
    expect(deleteSandboxInstanceMock).toHaveBeenCalledWith(
      "sandbox",
      "harness:session-1",
      undefined,
      "sbx_new",
    );
    expect(storedSandboxExternalId).toBeNull();
  });

  it("cleans up a newly claimed reservation when its lifecycle fails", async () => {
    execResult = {
      exit_code: 1,
      stdout: "",
      stderr: "pnpm setup failed",
    };
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      onCreate: ["npm install --global pnpm@10.34.5"],
      options: { workdirUrl: BASE },
    });

    await expect(
      executor.acquireHarnessReservation({
        reservationKey: "harness:session-1",
      }),
    ).rejects.toThrow("pnpm setup failed");

    expect(
      fetchCalls.some(
        (call) =>
          call.method === "DELETE" && call.path === "/v1/sandboxes/sbx_new",
      ),
    ).toBe(true);
    expect(storedSandboxExternalId).toBeNull();
  });

  it("resumes only an existing Harness reservation", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      options: { workdirUrl: BASE },
    });
    await expect(
      executor.resumeHarnessReservation({ reservationKey: "harness:missing" }),
    ).rejects.toThrow("no reserved workdir sandbox");

    storedSandboxExternalId = "sbx_stored";
    reconnectState = "stopped";
    expect(
      (
        await executor.resumeHarnessReservation({
          reservationKey: "harness:session-1",
        })
      ).id,
    ).toBe("sbx_stored");
    expect(fetchCalls.some((call) => call.path.endsWith("/resume"))).toBe(true);
  });

  it("suspends, resumes, snapshots, and reports instance info for a reserved sandbox", async () => {
    storedSandboxExternalId = "sbx_stored";
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      options: { workdirUrl: BASE },
    });

    await executor.suspend({ namespace: NS });
    expect(
      fetchCalls.some((c) => c.path === "/v1/sandboxes/sbx_stored/pause"),
    ).toBe(true);

    fetchCalls = [];
    await executor.resume({ namespace: NS });
    expect(
      fetchCalls.some((c) => c.path === "/v1/sandboxes/sbx_stored/resume"),
    ).toBe(true);

    fetchCalls = [];
    const snap = await executor.snapshot({ namespace: NS });
    expect(snap).toEqual({ snapshotId: "snap_1", externalImageId: "img_1" });

    fetchCalls = [];
    reconnectState = "standby";
    const info = await executor.getInstanceInfo({ namespace: NS });
    expect(info).toEqual({ externalId: "sbx_stored", state: "suspended" });
  });

  it("releases a reserved sandbox and drops its instance record", async () => {
    storedSandboxExternalId = "sbx_stored";
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      options: { workdirUrl: BASE },
    });

    await executor.release({ namespace: NS });
    expect(
      fetchCalls.some(
        (c) => c.method === "DELETE" && c.path === "/v1/sandboxes/sbx_stored",
      ),
    ).toBe(true);
    expect(deleteSandboxInstanceMock).toHaveBeenCalledWith(
      "sandbox",
      NS,
      undefined,
      "sbx_stored",
    );
  });

  it("releases the named sandbox when the reservation still points at it", async (): Promise<void> => {
    storedSandboxExternalId = "sbx_stored";
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      options: { workdirUrl: BASE },
    });

    await executor.release({
      namespace: NS,
      expectedExternalId: "sbx_stored",
    });
    expect(
      fetchCalls.some(
        (c) => c.method === "DELETE" && c.path === "/v1/sandboxes/sbx_stored",
      ),
    ).toBe(true);
  });

  it("leaves a reservation alone when another acquire already re-claimed it", async (): Promise<void> => {
    // The caller read sbx_old, but the key now points at a sandbox someone else
    // just claimed — deleting it would destroy live work.
    storedSandboxExternalId = "sbx_new";
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      options: { workdirUrl: BASE },
    });

    await executor.release({ namespace: NS, expectedExternalId: "sbx_old" });
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
    expect(deleteSandboxInstanceMock).not.toHaveBeenCalled();
  });

  it("returns null instance info when nothing is reserved", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      options: { workdirUrl: BASE },
    });
    expect(await executor.getInstanceInfo({ namespace: NS })).toBeNull();
  });
});
