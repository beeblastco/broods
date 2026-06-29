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

// The documented sandbox object shape (docs/API.md:124-152), trimmed.
function sandboxObject(id: string, state: string): Record<string, unknown> {
  return {
    id,
    runtime: "firecracker",
    image: "base",
    state,
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
    status,
    text: async () => (payload === undefined ? "" : JSON.stringify(payload)),
  } as unknown as Response;
}

const fetchMock = mock(async (url: string | URL, init?: RequestInit): Promise<Response> => {
  const full = String(url);
  const path = full.replace(/^https?:\/\/[^/]+/, "");
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  fetchCalls.push({ method, path, body, headers: (init?.headers ?? {}) as Record<string, string> });

  if (method === "POST" && path === "/v1/sandboxes") return jsonResponse(sandboxObject("sbx_new", "running"), 201);
  if (method === "GET" && /^\/v1\/sandboxes\/[^/]+$/.test(path)) {
    return jsonResponse(sandboxObject(path.split("/").pop()!, reconnectState));
  }
  if (method === "POST" && path.endsWith("/exec")) return jsonResponse({ exit_code: 0, stdout: "workdir ok\n", stderr: "" });
  if (method === "POST" && path.endsWith("/snapshot")) return jsonResponse({ id: "snap_1", image_id: "img_1" });
  if (method === "POST" && path.endsWith("/pause")) return jsonResponse(sandboxObject("sbx_stored", "stopped"));
  if (method === "POST" && path.endsWith("/resume")) return jsonResponse(sandboxObject("sbx_stored", "running"));
  if (method === "DELETE") return jsonResponse({});
  return jsonResponse({ error: { code: "not_found", message: path } }, 404);
});

let storedSandboxExternalId: string | null = null;
const getSandboxExternalIdMock = mock(async (_provider: string, _key: string) => storedSandboxExternalId);
const claimSandboxInstanceMock = mock(async (_provider: string, _key: string, externalId: string) => {
  storedSandboxExternalId = externalId;
  return true;
});
const saveSandboxInstanceMock = mock(async (_provider: string, _key: string, externalId: string) => {
  storedSandboxExternalId = externalId;
});
const deleteSandboxInstanceMock = mock(async () => {
  storedSandboxExternalId = null;
});

mock.module("../functions/harness-processing/sandbox/instance-store.ts", () => ({
  getSandboxExternalId: getSandboxExternalIdMock,
  claimSandboxInstance: claimSandboxInstanceMock,
  saveSandboxInstance: saveSandboxInstanceMock,
  deleteSandboxInstance: deleteSandboxInstanceMock,
}));

// Assume-role S3 mount path: stub STS so it returns fixed temporary credentials
// and capture the scoped session policy the executor builds.
let lastAssumeRoleInput: Record<string, unknown> | undefined;
const assumeRoleSendMock = mock(async () => ({
  Credentials: { AccessKeyId: "ASIA_TEMP", SecretAccessKey: "temp-secret", SessionToken: "temp-token" },
}));
mock.module("@aws-sdk/client-sts", () => ({
  STSClient: class { send = assumeRoleSendMock; },
  AssumeRoleCommand: class { constructor(input: Record<string, unknown>) { lastAssumeRoleInput = input; } },
}));

const NS = "fs-0123456789abcdef0123456789abcdef01234567";
const BASE = "https://workdir.test";

function execCalls(): FetchCall[] {
  return fetchCalls.filter((c) => c.path.endsWith("/exec"));
}

// The parsed body of the most recent create call.
function createBody(): Record<string, unknown> {
  const create = fetchCalls.find((c) => c.method === "POST" && c.path === "/v1/sandboxes");
  return (create?.body ?? {}) as Record<string, unknown>;
}

async function newExecutor(config: Record<string, unknown>) {
  const { WorkdirSandboxExecutor } = await import("../functions/harness-processing/sandbox/workdir-executor.ts");
  const options = config.options && typeof config.options === "object" && !Array.isArray(config.options)
    ? { ...(config.options as Record<string, unknown>) }
    : undefined;
  const safeConfig = options?.workdirUrl && !options.apiKey
    ? { ...config, options: { ...options, apiKey: "tenant-workdir-key" } }
    : config;
  return new WorkdirSandboxExecutor(safeConfig as never);
}

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchCalls = [];
  reconnectState = "running";
  storedSandboxExternalId = null;
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
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createSandboxExecutor (sandbox provider)", () => {
  it("creates the WorkdirSandboxExecutor for provider 'sandbox'", () => {
    process.env.WORKDIR_URL = BASE;
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    expect(createSandboxExecutor({ provider: "sandbox" }).constructor.name).toBe("WorkdirSandboxExecutor");
  });

  it("throws when no workdir base URL is configured", () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    expect(() => createSandboxExecutor({ provider: "sandbox" })).toThrow(/WORKDIR_URL/);
  });

  it("requires a tenant API key when a tenant workdir URL is configured", async () => {
    const { WorkdirSandboxExecutor } = await import("../functions/harness-processing/sandbox/workdir-executor.ts");
    expect(() => new WorkdirSandboxExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE },
    } as never)).toThrow("config.options.apiKey is required");
  });

  it("rejects unsafe tenant workdir URLs", async () => {
    const { WorkdirSandboxExecutor } = await import("../functions/harness-processing/sandbox/workdir-executor.ts");
    expect(() => new WorkdirSandboxExecutor({
      provider: "sandbox",
      options: { workdirUrl: "http://127.0.0.1:7777", apiKey: "tenant-key" },
    } as never)).toThrow("config.options.workdirUrl must use https");
  });
});

describe("WorkdirSandboxExecutor.run", () => {
  it("creates an ephemeral sandbox, execs in the workspace cwd, then deletes it", async () => {
    const executor = await newExecutor({ provider: "sandbox", options: { workdirUrl: BASE } });

    const result = await executor.run({
      code: "echo hi && ls",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    // exit_code:0 from the documented ExecResult, parsed by the real SDK.
    expect(result).toMatchObject({ ok: true, provider: "sandbox", stdout: "workdir ok\n", exitCode: 0 });
    expect(fetchCalls.find((c) => c.method === "POST" && c.path === "/v1/sandboxes")).toBeTruthy();
    expect(execCalls()[0]!.body).toMatchObject({ cmd: "echo hi && ls", cwd: `/mnt/workspaces/${NS}` });
    // Ephemeral sandboxes are torn down after the call.
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("reads the base URL and bearer key from env when options omit them", async () => {
    process.env.WORKDIR_URL = BASE;
    process.env.WORKDIR_API_KEY = "sk_test";
    const executor = await newExecutor({ provider: "sandbox" });

    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });

    const create = fetchCalls.find((c) => c.path === "/v1/sandboxes")!;
    expect(create.headers.Authorization).toBe("Bearer sk_test");
  });

  it("maps the predefined resource knobs onto the SDK's snake_case wire shape", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE, cpu: 2, memoryMb: 4096, diskGb: 16 },
    });
    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    // The SDK converts memoryMb -> memory_mb, diskGb -> disk_gb.
    expect(createBody().resources).toEqual({ cpu: 2, memory_mb: 4096, disk_gb: 16 });
  });

  it("derives create-time resources from the predefined size (medium)", async () => {
    const executor = await newExecutor({ provider: "sandbox", size: "medium", options: { workdirUrl: BASE } });
    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    expect(createBody().resources).toEqual({ cpu: 2, memory_mb: 4096, disk_gb: 16 });
  });

  it("clamps the size vcpu to workdir's allowed set (tiny 0.25 -> 0.5) and lets explicit options win", async () => {
    const executor = await newExecutor({ provider: "sandbox", size: "tiny", options: { workdirUrl: BASE, memoryMb: 2048 } });
    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    expect(createBody().resources).toEqual({ cpu: 0.5, memory_mb: 2048, disk_gb: 8 });
  });

  it("launches from the config snapshot pin, preferring it over the options.image alias", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      snapshot: "img_curated",
      options: { workdirUrl: BASE, image: "img_legacy" },
    });
    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    expect(createBody().image).toBe("img_curated");
  });

  it("maps network modes onto workdir egress policy", async () => {
    const allowAll = await newExecutor({ provider: "sandbox", network: { mode: "allow-all" }, options: { workdirUrl: BASE } });
    await allowAll.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    expect((createBody().startup as Record<string, unknown>).network).toEqual({ egress: "default" });

    fetchCalls = [];
    const denyAll = await newExecutor({ provider: "sandbox", network: { mode: "deny-all" }, options: { workdirUrl: BASE } });
    await denyAll.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    expect((createBody().startup as Record<string, unknown>).network).toEqual({ egress: "none" });

    fetchCalls = [];
    const restricted = await newExecutor({
      provider: "sandbox",
      network: { mode: "restricted", allowDomains: ["api.example.com"], allowCidrs: ["10.0.0.0/8"] },
      options: { workdirUrl: BASE },
    });
    await restricted.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    expect((createBody().startup as Record<string, unknown>).network).toEqual({
      egress: "allowlist",
      allow: [{ type: "domain", value: "api.example.com" }, "10.0.0.0/8"],
    });
  });

  it("declares a top-level S3 mount and references AWS secret env names (not inline creds)", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE, mountAwsS3Buckets: true, workspaceRoot: "/mnt/workspaces" },
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
    expect(body.mounts).toEqual([{
      type: "s3",
      bucket: "workspace-bucket",
      mount_path: `/mnt/workspaces/${NS}`,
      // workdir defaults S3 mounts to read-only; the workspace mount opts out.
      read_only: false,
      prefix: `${NS}/`,
      region: "us-east-1",
    }]);
    // Creds come from the guest secret env: mount-s3 reads spec.secret_env, which
    // workdir populates from these named org secrets at boot.
    expect((body.startup as Record<string, unknown>).secrets).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
    expect(JSON.stringify(body)).not.toContain("startup.env");
  });

  it("rejects an S3 mount without a namespace", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE, mountAwsS3Buckets: true },
    });

    await expect(executor.run({ code: "ls", timeoutSeconds: 30, outputLimitBytes: 4096 }))
      .rejects.toThrow("workdir AWS S3 workspace mount requires a workspace namespace");
  });

  it("mounts S3 via exec with scoped assume-role credentials when SANDBOX_MOUNT_ROLE_ARN is set", async () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::123456789012:role/sandbox-mount";
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE, mountAwsS3Buckets: true, workspaceRoot: "/mnt/workspaces" },
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
    expect((body.startup as Record<string, unknown> | undefined)?.secrets).toBeUndefined();

    // Instead the workspace is mounted via exec with short-lived, namespace-scoped
    // credentials (including the session token) handed in as per-call env.
    const mount = execCalls().find((c) => String(c.body?.cmd).includes("mount-s3"));
    expect(mount).toBeTruthy();
    expect(String(mount!.body?.cmd)).toContain(`'--prefix' '${NS}/'`);
    expect(String(mount!.body?.cmd)).toContain("'--allow-delete'");
    expect(String(mount!.body?.cmd)).toContain("'--allow-overwrite'");
    expect(mount!.body?.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "ASIA_TEMP",
      AWS_SECRET_ACCESS_KEY: "temp-secret",
      AWS_SESSION_TOKEN: "temp-token",
    });
    // The assumed session is scoped to this namespace's bucket prefix only.
    expect(String(lastAssumeRoleInput?.Policy)).toContain(`workspace-bucket/${NS}/`);
  });

  it("requires a namespace for the assume-role S3 mount", async () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::123456789012:role/sandbox-mount";
    const executor = await newExecutor({
      provider: "sandbox",
      options: { workdirUrl: BASE, mountAwsS3Buckets: true },
    });

    await expect(executor.run({ code: "ls", timeoutSeconds: 30, outputLimitBytes: 4096 }))
      .rejects.toThrow("workdir AWS S3 workspace mount requires a workspace namespace");
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
        auth: { type: "assumeRole", roleArn: "arn:aws:iam::222222222222:role/byo", externalId: "ext-7" },
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
    const mount = execCalls().find((c) => String(c.body?.cmd).includes("mount-s3"));
    expect(mount).toBeTruthy();
    expect(String(mount!.body?.cmd)).toContain("'acme-bucket'");
    // Whole-bucket BYO mount (no prefix configured) omits --prefix.
    expect(String(mount!.body?.cmd)).not.toContain("--prefix");
    expect(mount!.body?.env).toMatchObject({ AWS_ACCESS_KEY_ID: "ASIA_TEMP", AWS_SESSION_TOKEN: "temp-token" });
    // The developer's role is assumed with their ExternalId.
    expect(lastAssumeRoleInput?.RoleArn).toBe("arn:aws:iam::222222222222:role/byo");
    expect(lastAssumeRoleInput?.ExternalId).toBe("ext-7");
  });

  it("reserves a persistent sandbox, reconnects by stored id, and never deletes it", async () => {
    const executor = await newExecutor({ provider: "sandbox", persistent: true, options: { workdirUrl: BASE } });

    // First call: no stored id => create + claim.
    await executor.run({ code: "echo one", reservationKey: "tool:acct_1", timeoutSeconds: 30, outputLimitBytes: 4096 });
    expect(claimSandboxInstanceMock).toHaveBeenCalledWith("sandbox", "tool:acct_1", "sbx_new");
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);

    // Second call: stored + idled => GET then resume, no new create.
    fetchCalls = [];
    reconnectState = "stopped";
    await executor.run({ code: "echo two", reservationKey: "tool:acct_1", timeoutSeconds: 30, outputLimitBytes: 4096 });
    expect(fetchCalls.some((c) => c.method === "POST" && c.path === "/v1/sandboxes")).toBe(false);
    expect(fetchCalls.some((c) => c.path.endsWith("/resume"))).toBe(true);
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("runs onCreate/onResume lifecycle hooks for a persistent sandbox", async () => {
    const executor = await newExecutor({
      provider: "sandbox",
      persistent: true,
      onCreate: ["echo create > hook.txt"],
      onResume: ["echo resume >> hook.txt"],
      options: { workdirUrl: BASE },
    });

    await executor.run({ code: "cat hook.txt", reservationKey: "tool:acct_1", timeoutSeconds: 30, outputLimitBytes: 4096 });
    expect(execCalls().find((c) => String(c.body?.cmd).includes("echo create > hook.txt"))).toBeTruthy();
  });
});

describe("WorkdirSandboxExecutor background jobs", () => {
  it("launches a detached job through exec for a persistent sandbox", async () => {
    const executor = await newExecutor({ provider: "sandbox", persistent: true, options: { workdirUrl: BASE } });

    const handle = await executor.runBackground({
      code: "node runner.js",
      reservationKey: "tool:acct_1",
      jobId: "job_test",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(handle).toEqual({ jobId: "job_test" });
    const launch = execCalls().find((c) => String(c.body?.cmd).includes("setsid bash -c"));
    expect(launch).toBeTruthy();
    expect(String(launch!.body?.cmd)).toContain("job_test.running");
  });

  it("requires a persistent reservation for background jobs", async () => {
    const executor = await newExecutor({ provider: "sandbox", options: { workdirUrl: BASE } });
    await expect(executor.runBackground({ code: "x", timeoutSeconds: 30, outputLimitBytes: 4096 }))
      .rejects.toThrow("background jobs require a persistent workdir sandbox reservation key");
  });
});

describe("WorkdirSandboxExecutor lifecycle", () => {
  it("suspends, resumes, snapshots, and reports instance info for a reserved sandbox", async () => {
    storedSandboxExternalId = "sbx_stored";
    const executor = await newExecutor({ provider: "sandbox", persistent: true, options: { workdirUrl: BASE } });

    await executor.suspend({ namespace: NS });
    expect(fetchCalls.some((c) => c.path === "/v1/sandboxes/sbx_stored/pause")).toBe(true);

    fetchCalls = [];
    await executor.resume({ namespace: NS });
    expect(fetchCalls.some((c) => c.path === "/v1/sandboxes/sbx_stored/resume")).toBe(true);

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
    const executor = await newExecutor({ provider: "sandbox", persistent: true, options: { workdirUrl: BASE } });

    await executor.release({ namespace: NS });
    expect(fetchCalls.some((c) => c.method === "DELETE" && c.path === "/v1/sandboxes/sbx_stored")).toBe(true);
    expect(deleteSandboxInstanceMock).toHaveBeenCalledWith("sandbox", NS);
  });

  it("returns null instance info when nothing is reserved", async () => {
    const executor = await newExecutor({ provider: "sandbox", persistent: true, options: { workdirUrl: BASE } });
    expect(await executor.getInstanceInfo({ namespace: NS })).toBeNull();
  });
});
