/**
 * Sandbox executor tests.
 * Cover provider selection + the single run() contract without invoking real
 * third-party services.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const e2bDisconnectMock = mock(async () => {});
const e2bRunMock = mock(async (_command: string, options: Record<string, unknown>) => {
  if (options.background === true) {
    return {
      pid: 123,
      disconnect: e2bDisconnectMock,
    };
  }
  return {
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
  };
});
const e2bKillMock = mock(async () => {});
const e2bCreateMock = mock(async (_options: Record<string, unknown>) => ({
  sandboxId: "e2b-sandbox",
  commands: {
    run: e2bRunMock,
  },
  kill: e2bKillMock,
}));

const daytonaExecuteCommandMock = mock(async (_command: string, _cwd?: string, _env?: unknown, _timeout?: number) => ({
  exitCode: 0,
  result: "ok\n",
}));
const daytonaDeleteMock = mock(async () => {});
let daytonaClientOptionsSeen: Record<string, unknown>[] = [];
const daytonaCreateMock = mock(async (_options: Record<string, unknown>) => ({
  process: {
    executeCommand: daytonaExecuteCommandMock,
  },
  delete: daytonaDeleteMock,
}));
const vercelRunCommandMock = mock(async (_params: Record<string, unknown>) => ({
  exitCode: 0,
  stdout: async () => "vercel ok\n",
  stderr: async () => "",
}));
const vercelStopMock = mock(async () => {});
const vercelDeleteMock = mock(async () => {});
function vercelSandbox(name = "vercel-sandbox") {
  return {
    name,
    runCommand: vercelRunCommandMock,
    stop: vercelStopMock,
    delete: vercelDeleteMock,
  };
}
const vercelCreateMock = mock(async (_options: Record<string, unknown>) => vercelSandbox("ephemeral"));
const vercelGetMock = mock(async (options: Record<string, unknown>) => {
  const sandbox = vercelSandbox(String(options.name ?? "stored"));
  if (typeof options.onResume === "function") await options.onResume(sandbox);
  return sandbox;
});
const vercelGetOrCreateMock = mock(async (options: Record<string, unknown>) => {
  const sandbox = vercelSandbox(String(options.name ?? "created"));
  if (typeof options.onCreate === "function") await options.onCreate(sandbox);
  return sandbox;
});
function vercelCommandIncludes(text: string): boolean {
  return vercelRunCommandMock.mock.calls.some((call) => {
    const params = call[0] as { args?: string[] } | undefined;

    return params?.args?.[1]?.includes(text) === true;
  });
}
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
const stsSendMock = mock(async (_command: unknown) => ({
  Credentials: {
    AccessKeyId: "scoped-access-key",
    SecretAccessKey: "scoped-secret-key",
    SessionToken: "scoped-session-token",
  },
}));
// AWS Lambda MicroVM mocks: RunMicrovm/auth-token/lifecycle go through the SDK
// client; the exec request itself is an HTTPS POST to the VM endpoint (fetch).
let microvmExecPayload = {
  ok: true,
  runtime: "bash",
  exit_code: 0,
  timed_out: false,
  duration_ms: 5,
  stdout: "shell ok\n",
  stderr: "",
};
let microvmGetResponses: Array<Record<string, unknown> | Error> = [];
const microvmSendMock = mock(async (command: { _type?: string }) => {
  switch (command?._type) {
    case "RunMicrovm":
      return { microvmId: "microvm-1", endpoint: "microvm-1.lambda-microvm.us-east-1.on.aws", state: "PENDING" };
    case "CreateMicrovmAuthToken":
      return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
    case "CreateMicrovmShellAuthToken":
      return { authToken: { "X-aws-proxy-auth": "shell-jwe-token" } };
    case "GetMicrovm":
      if (microvmGetResponses.length > 0) {
        const next = microvmGetResponses.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      return { microvmId: "microvm-1", endpoint: "microvm-1.lambda-microvm.us-east-1.on.aws", state: "RUNNING" };
    default:
      return {};
  }
});
const originalFetch = globalThis.fetch;
const microvmFetchMock = mock(async (_url: string, _init?: unknown) =>
  new Response(JSON.stringify(microvmExecPayload), { status: 200, headers: { "content-type": "application/json" } }),
);
function microvmCommand(type: string) {
  return class {
    input: unknown;
    _type = type;
    constructor(input: unknown) {
      this.input = input;
    }
  };
}
const microvmRunInput = (): Record<string, unknown> => {
  const call = microvmSendMock.mock.calls.find((c) => (c[0] as { _type?: string })?._type === "RunMicrovm");
  return (call![0] as { input: Record<string, unknown> }).input;
};
mock.module("e2b", () => ({
  Sandbox: {
    create: e2bCreateMock,
  },
}));

mock.module("@daytona/sdk", () => ({
  Daytona: class {
    constructor(options: Record<string, unknown>) {
      daytonaClientOptionsSeen.push(options);
    }

    create = daytonaCreateMock;
  },
}));

mock.module("@vercel/sandbox", () => ({
  Sandbox: {
    create: vercelCreateMock,
    get: vercelGetMock,
    getOrCreate: vercelGetOrCreateMock,
  },
}));

mock.module("../functions/harness-processing/sandbox/instance-store.ts", () => ({
  getSandboxExternalId: getSandboxExternalIdMock,
  claimSandboxInstance: claimSandboxInstanceMock,
  saveSandboxInstance: saveSandboxInstanceMock,
  deleteSandboxInstance: deleteSandboxInstanceMock,
}));

mock.module("@aws-sdk/client-lambda-microvms", () => ({
  LambdaMicrovms: class {
    send = microvmSendMock;
  },
  RunMicrovmCommand: microvmCommand("RunMicrovm"),
  CreateMicrovmAuthTokenCommand: microvmCommand("CreateMicrovmAuthToken"),
  CreateMicrovmShellAuthTokenCommand: microvmCommand("CreateMicrovmShellAuthToken"),
  TerminateMicrovmCommand: microvmCommand("TerminateMicrovm"),
  GetMicrovmCommand: microvmCommand("GetMicrovm"),
  SuspendMicrovmCommand: microvmCommand("SuspendMicrovm"),
  ResumeMicrovmCommand: microvmCommand("ResumeMicrovm"),
}));

mock.module("@aws-sdk/client-sts", () => ({
  STSClient: class {
    send = stsSendMock;
  },
  AssumeRoleCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

beforeEach(() => {
  process.env.AWS_ACCESS_KEY_ID = "test-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.AWS_SESSION_TOKEN = "test-session-token";
  process.env.AWS_REGION = "us-east-1";
  process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::123456789012:role/sandbox-s3mount";
  process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
  process.env.SKILLS_BUCKET_NAME = "skills-bucket";
  process.env.PERSISTENT_SANDBOX_INSTANCE_TABLE_NAME = "persistent-sandbox-instance";
  process.env.MICROVM_IMAGE_IDENTIFIER = "arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox";
  process.env.MICROVM_EXECUTION_ROLE_ARN = "arn:aws:iam::123456789012:role/microvm-execution";
  process.env.MICROVM_EGRESS_NETWORK_CONNECTOR_ARN = "arn:aws:lambda:us-east-1:123456789012:network-connector:vpc-egress";
  globalThis.fetch = microvmFetchMock as unknown as typeof fetch;
  e2bRunMock.mockClear();
  e2bDisconnectMock.mockClear();
  e2bKillMock.mockClear();
  e2bCreateMock.mockClear();
  daytonaExecuteCommandMock.mockClear();
  daytonaDeleteMock.mockClear();
  daytonaCreateMock.mockClear();
  daytonaClientOptionsSeen = [];
  vercelRunCommandMock.mockClear();
  vercelStopMock.mockClear();
  vercelDeleteMock.mockClear();
  vercelCreateMock.mockClear();
  vercelGetMock.mockClear();
  vercelGetOrCreateMock.mockClear();
  storedSandboxExternalId = null;
  getSandboxExternalIdMock.mockClear();
  claimSandboxInstanceMock.mockClear();
  saveSandboxInstanceMock.mockClear();
  deleteSandboxInstanceMock.mockClear();
  microvmSendMock.mockClear();
  microvmFetchMock.mockClear();
  microvmGetResponses = [];
  microvmExecPayload = {
    ok: true,
    runtime: "bash",
    exit_code: 0,
    timed_out: false,
    duration_ms: 5,
    stdout: "shell ok\n",
    stderr: "",
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const NS = "fs-0123456789abcdef0123456789abcdef01234567";
const CHILD_NS = `${NS}/issues/fs-76543210fedcba9876543210fedcba9876543210`;

describe("createSandboxExecutor", () => {
  it("requires an explicit provider and never silently defaults", () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    expect(() => createSandboxExecutor({})).toThrow(/provider/);
    expect(createSandboxExecutor({ provider: "lambda" }).constructor.name).toBe("MicrovmSandboxExecutor");
  });

  it("creates E2B, Daytona, and Vercel executor adapters", () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    expect(createSandboxExecutor({ provider: "e2b" }).constructor.name).toBe("E2BSandboxExecutor");
    expect(createSandboxExecutor({ provider: "daytona" }).constructor.name).toBe("DaytonaSandboxExecutor");
    expect(createSandboxExecutor({ provider: "vercel" }).constructor.name).toBe("VercelSandboxExecutor");
  });

  it("runs a MicroVM and mounts the workspace via the run-hook payload when a namespace is present", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda" });

    const result = await executor.run({
      code: "echo ok",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "lambda", stdout: "shell ok\n" });
    // RunMicrovm carries the image identifier + a run-hook payload describing the
    // workspace mount (namespace + scoped, short-lived assume-role creds).
    const runInput = microvmRunInput();
    expect(runInput.imageIdentifier).toBe("arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox");
    expect(runInput.executionRoleArn).toBe("arn:aws:iam::123456789012:role/microvm-execution");
    const payload = JSON.parse(runInput.runHookPayload as string);
    expect(payload.workspace).toMatchObject({ namespace: NS, root: "/mnt/workspaces" });
    expect(payload.workspace.mount).toMatchObject({
      bucket: "workspace-bucket",
      prefix: `${NS}/`,
      env: { AWS_ACCESS_KEY_ID: "scoped-access-key" },
    });
    // The exec request is POSTed to the VM endpoint with the proxy auth headers.
    const [url, init] = microvmFetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://microvm-1.lambda-microvm.us-east-1.on.aws/exec");
    expect(init.headers["X-aws-proxy-auth"]).toBe("proxy-token");
    expect(init.headers["X-aws-proxy-port"]).toBe("8080");
    expect(JSON.parse(init.body)).toMatchObject({
      runtime: "bash",
      code: "echo ok",
      namespace: NS,
      workspace_root: "/mnt/workspaces",
      timeout_ms: 30000,
    });
  });

  it("uses a flat MicroVM local namespace while mounting the hierarchical storage prefix", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda", persistent: true });

    await executor.run({
      code: "pwd",
      namespace: CHILD_NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(claimSandboxInstanceMock.mock.calls[0]?.[1]).toBe(CHILD_NS);
    const runInput = microvmRunInput();
    // Persistent (reserved) VMs attach the managed shell-ingress connector at
    // launch so the dashboard terminal can mint shell tokens later.
    expect(runInput.ingressNetworkConnectors).toEqual([
      "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
      "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:SHELL_INGRESS",
    ]);
    const payload = JSON.parse(runInput.runHookPayload as string);
    expect(payload.workspace).toMatchObject({ namespace: NS, root: "/mnt/workspaces" });
    expect(payload.workspace.mount).toMatchObject({
      bucket: "workspace-bucket",
      prefix: `${CHILD_NS}/`,
    });
    const init = microvmFetchMock.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({
      namespace: NS,
      workspace_root: "/mnt/workspaces",
    });
  });

  it("launches from the config snapshot pin, overriding the MICROVM_IMAGE_IDENTIFIER default", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({
      provider: "lambda",
      snapshot: "arn:aws:lambda:us-east-1:123456789012:microvm-image:curated",
    });

    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });

    expect(microvmRunInput().imageIdentifier).toBe("arn:aws:lambda:us-east-1:123456789012:microvm-image:curated");
  });

  it("runs a stateless MicroVM with default internet egress and no workspace mount", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda", network: { mode: "allow-all" } });

    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    const runInput = microvmRunInput();
    expect(runInput.runHookPayload).toBeUndefined();
    expect(runInput.egressNetworkConnectors).toBeUndefined();
    // Ephemeral VMs never serve a terminal, so no shell ingress is attached.
    expect(runInput.ingressNetworkConnectors).toBeUndefined();
    const init = microvmFetchMock.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(init.body).namespace).toBeUndefined();
  });

  it("mints a native shell connection target for a reserved MicroVM", async () => {
    const { microvmShellConnection, MICROVM_SHELL_AUTH_HEADER } = require("../functions/harness-processing/sandbox/microvm-executor.ts");

    const shell = await microvmShellConnection("microvm-1");

    expect(MICROVM_SHELL_AUTH_HEADER).toBe("X-aws-proxy-auth");
    expect(shell).toEqual({
      url: "wss://microvm-1.lambda-microvm.us-east-1.on.aws",
      authorization: "shell-jwe-token",
    });
  });

  it("reconnects to a reserved MicroVM for a persistent run and never terminates it", async () => {
    storedSandboxExternalId = "microvm-1";
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda", persistent: true });

    const result = await executor.run({
      code: "echo ok", namespace: NS, workspaceRoot: "/mnt/workspaces", timeoutSeconds: 30, outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "lambda" });
    const types = microvmSendMock.mock.calls.map((c) => (c[0] as { _type?: string })?._type);
    // Reconnected via GetMicrovm; no fresh RunMicrovm and no Terminate (persistent).
    expect(types).toContain("GetMicrovm");
    expect(types).not.toContain("RunMicrovm");
    expect(types).not.toContain("TerminateMicrovm");
  });

  it("resumes a suspended reserved MicroVM before using its endpoint", async () => {
    storedSandboxExternalId = "microvm-1";
    microvmGetResponses = [
      { microvmId: "microvm-1", state: "SUSPENDED" },
      { microvmId: "microvm-1", endpoint: "microvm-1.lambda-microvm.us-east-1.on.aws", state: "RUNNING" },
    ];
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda", persistent: true });

    await executor.run({
      code: "echo ok", namespace: NS, workspaceRoot: "/mnt/workspaces", timeoutSeconds: 30, outputLimitBytes: 4096,
    });

    const types = microvmSendMock.mock.calls.map((c) => (c[0] as { _type?: string })?._type);
    expect(types.filter((type) => type === "GetMicrovm")).toHaveLength(2);
    expect(types).toContain("ResumeMicrovm");
    expect(microvmFetchMock).toHaveBeenCalled();
  });

  it("recreates the reserved MicroVM only when the provider says it is gone", async () => {
    storedSandboxExternalId = "microvm-gone";
    microvmGetResponses = [
      Object.assign(new Error("MicroVM does not exist"), { name: "ResourceNotFoundException" }),
    ];
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda", persistent: true });

    const result = await executor.run({
      code: "echo ok", namespace: NS, workspaceRoot: "/mnt/workspaces", timeoutSeconds: 30, outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "lambda" });
    const types = microvmSendMock.mock.calls.map((c) => (c[0] as { _type?: string })?._type);
    expect(types).toContain("RunMicrovm");
    // The stale row is dropped conditionally on the dead id, so a concurrent
    // re-claim with a fresh VM is never deleted out from under it.
    expect(deleteSandboxInstanceMock).toHaveBeenCalledWith("lambda", NS, "microvm-gone");
  });

  it("surfaces transient reconnect failures instead of replacing (and leaking) the reserved MicroVM", async () => {
    storedSandboxExternalId = "microvm-1";
    microvmGetResponses = [
      Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }),
    ];
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda", persistent: true });

    await expect(executor.run({
      code: "echo ok", namespace: NS, workspaceRoot: "/mnt/workspaces", timeoutSeconds: 30, outputLimitBytes: 4096,
    })).rejects.toThrow("Rate exceeded");

    const types = microvmSendMock.mock.calls.map((c) => (c[0] as { _type?: string })?._type);
    expect(types).not.toContain("RunMicrovm");
    expect(deleteSandboxInstanceMock).not.toHaveBeenCalled();
  });

  it("reports a missing reserved MicroVM as absent during status refresh", async () => {
    storedSandboxExternalId = "microvm-missing";
    microvmGetResponses = [
      Object.assign(new Error("MicroVM does not exist"), { name: "ResourceNotFoundException" }),
    ];
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda", persistent: true });

    await expect(executor.getInstanceInfo({ namespace: NS })).resolves.toBeNull();
  });

  it("fails persistent MicroVM runs when a lifecycle hook exits nonzero", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    microvmExecPayload = {
      ...microvmExecPayload,
      ok: false,
      exit_code: 22,
      stdout: "",
      stderr: "hook failed\n",
    };
    const executor = createSandboxExecutor({ provider: "lambda", persistent: true, onCreate: "exit 22" });

    await expect(executor.run({
      code: "echo ok", namespace: NS, workspaceRoot: "/mnt/workspaces", timeoutSeconds: 30, outputLimitBytes: 4096,
    })).rejects.toThrow("hook failed");
  });

  it("launches a detached background job in the persistent MicroVM and returns a jobId", async () => {
    storedSandboxExternalId = "microvm-1";
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda", persistent: true });

    const handle = await executor.runBackground({
      code: "uv run train.py",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
      jobId: "job_test",
      callback: { url: "https://fn.example/sandbox-jobs/job_test/complete", token: "tok-123" },
    });

    expect(handle.jobId).toBe("job_test");
    // The launch script is POSTed to the VM /exec as a detached setsid session; the
    // marker files live beside the workspace mount (not under the S3 mount).
    const init = microvmFetchMock.mock.calls[0]![1] as { body: string };
    const launched = JSON.parse(init.body).code as string;
    expect(launched).toContain("setsid bash");
    expect(launched).toContain("job_test.running");
    expect(launched).toContain(`.fp-jobs/${NS}`);
  });

  it("passes the egress network connector for a restricted MicroVM network", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({
      provider: "lambda",
      network: { mode: "restricted", allowDomains: ["api.example.com"], allowCidrs: ["10.0.0.0/8"] },
    });

    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    const runInput = microvmRunInput();
    expect(runInput.egressNetworkConnectors).toEqual([
      "arn:aws:lambda:us-east-1:123456789012:network-connector:vpc-egress",
    ]);
  });

  it("fails closed when a restricted MicroVM network has no egress connector", async () => {
    delete process.env.MICROVM_EGRESS_NETWORK_CONNECTOR_ARN;
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda", network: { mode: "restricted", allowDomains: ["api.example.com"] } });

    await expect(executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 }))
      .rejects.toThrow("MICROVM_EGRESS_NETWORK_CONNECTOR_ARN");
    expect(microvmSendMock).not.toHaveBeenCalled();
  });

  it("applies the harness output limit to MicroVM responses", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    microvmExecPayload = {
      ...microvmExecPayload,
      stdout: "abcdef",
      stderr: "uvwxyz",
    };
    const executor = createSandboxExecutor({ provider: "lambda" });

    const result = await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 3 });

    expect(result.stdout).toBe("abc\n[output truncated]");
    expect(result.stderr).toBe("uvw\n[output truncated]");
    expect(result.truncated).toBe(true);
  });

  it("does not synthesize an S3 workspace cwd for E2B commands", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({
      provider: "e2b",
      envVars: { MY_API_BASE: "https://api.example.com" },
      options: { workspaceRoot: "/workspace", template: "mounted-template" },
    });

    const result = await executor.run({
      code: "mkdir -p notes && echo hi > notes/a.txt && cat notes/a.txt",
      namespace: NS,
      workspaceRoot: "/workspace",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "e2b", stdout: "ok\n" });
    expect(e2bCreateMock).toHaveBeenCalledWith(expect.objectContaining({ template: "mounted-template" }));
    expect(e2bRunMock.mock.calls[0]).toEqual([
      "mkdir -p notes && echo hi > notes/a.txt && cat notes/a.txt",
      {
        timeoutMs: 30000,
        envs: { MY_API_BASE: "https://api.example.com" },
      },
    ]);
    expect(e2bKillMock).toHaveBeenCalledTimes(1);
  });

  it("does not synthesize a workspace cwd for stateless E2B commands", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "e2b" });

    await executor.run({ code: "echo user", timeoutSeconds: 30, outputLimitBytes: 4096 });

    expect(e2bRunMock).toHaveBeenCalledTimes(1);
    expect(e2bRunMock.mock.calls[0]).toEqual([
      "echo user",
      {
        timeoutMs: 30000,
        envs: {},
      },
    ]);
  });

  it("launches persistent E2B background jobs with the native command API", async () => {
    const { E2BSandboxExecutor } = await import("../functions/harness-processing/sandbox/e2b-executor.ts");
    const executor = new E2BSandboxExecutor({
      provider: "e2b",
      persistent: true,
      network: { mode: "allow-all" },
      options: { template: "runtime-template" },
    });

    const handle = await executor.runBackground({
      code: "node runner.js",
      reservationKey: "custom-tool:acct_1:tool_1",
      jobId: "job_test",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(handle).toEqual({ jobId: "job_test" });
    expect(e2bRunMock).toHaveBeenCalledWith("node runner.js", {
      background: true,
      timeoutMs: 30000,
      envs: {},
    });
    expect(e2bDisconnectMock).toHaveBeenCalledTimes(1);
  });

  it("runs Daytona commands as-is and mounts the workspace bucket", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({
      provider: "daytona",
      envVars: { MY_API_BASE: "https://api.example.com" },
      options: {
        organizationId: "org-id",
        workspaceRoot: "/mnt/workspaces",
        snapshot: "fuse-s3",
        mountAwsS3Buckets: true,
      },
    });

    const result = await executor.run({
      code: "echo hi && ls",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 45,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "daytona", stdout: "ok\n" });
    expect(daytonaCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: "fuse-s3",
      language: "typescript",
      envVars: {
        MY_API_BASE: "https://api.example.com",
        AWS_ACCESS_KEY_ID: "scoped-access-key",
        AWS_SECRET_ACCESS_KEY: "scoped-secret-key",
        AWS_SESSION_TOKEN: "scoped-session-token",
        AWS_REGION: "us-east-1",
        AWS_DEFAULT_REGION: "us-east-1",
      },
    }));
    // The sandbox gets role-scoped credentials, never the harness runtime's own.
    const assumeRoleInput = (stsSendMock.mock.calls.at(-1)?.[0] as { input: { RoleArn: string; Policy?: string } }).input;
    expect(assumeRoleInput.RoleArn).toBe("arn:aws:iam::123456789012:role/sandbox-s3mount");
    expect(assumeRoleInput.Policy).toContain(`workspace-bucket/${NS}/`);
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      `mountpoint -q '/mnt/workspaces/${NS}' || sudo -E mount-s3 --uid "$(id -u)" --gid "$(id -g)" '--allow-delete' '--allow-overwrite' '--allow-other' '--prefix' '${NS}/' '--region' 'us-east-1' 'workspace-bucket' '/mnt/workspaces/${NS}'`,
    );
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      "echo hi && ls",
      `/mnt/workspaces/${NS}`,
      undefined,
      45,
    );
    expect(daytonaDeleteMock).toHaveBeenCalledTimes(1);
  });

  it("requires a tenant API key when a tenant Daytona API URL is configured", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({
      provider: "daytona",
      options: { apiUrl: "https://tenant-daytona.example.com" },
    });

    await expect(executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 }))
      .rejects.toThrow("config.options.apiKey is required");
    expect(daytonaCreateMock).not.toHaveBeenCalled();
  });

  it("rejects unsafe tenant Daytona API URLs", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({
      provider: "daytona",
      options: { apiUrl: "https://169.254.169.254", apiKey: "tenant-key" },
    });

    await expect(executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 }))
      .rejects.toThrow("config.options.apiUrl must not target");
    expect(daytonaCreateMock).not.toHaveBeenCalled();
  });

  it("passes tenant Daytona API URLs only with tenant credentials", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({
      provider: "daytona",
      options: { apiUrl: "https://tenant-daytona.example.com", apiKey: "tenant-key" },
    });

    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });

    expect(daytonaClientOptionsSeen[0]).toMatchObject({
      apiUrl: "https://tenant-daytona.example.com",
      apiKey: "tenant-key",
    });
  });

  it("rejects Daytona S3 mounts without a namespace before assuming the mount role", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const stsCallCount = stsSendMock.mock.calls.length;
    const executor = createSandboxExecutor({
      provider: "daytona",
      options: {
        organizationId: "org-id",
        workspaceRoot: "/mnt/workspaces",
        snapshot: "fuse-s3",
        mountAwsS3Buckets: true,
      },
    });

    await expect(executor.run({
      code: "echo hi",
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    })).rejects.toThrow("Daytona AWS S3 mounts require a workspace namespace");

    expect(stsSendMock.mock.calls.length).toBe(stsCallCount);
  });

  it("mounts a Daytona bring-your-own bucket via the workspace storage assume-role", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({
      provider: "daytona",
      storage: {
        provider: "s3",
        bucket: "acme",
        region: "us-west-2",
        endpoint: "https://r2.example.com",
        prefix: "agents/",
        auth: { type: "assumeRole", roleArn: "arn:aws:iam::222:role/byo", externalId: "ext-7" },
      },
      options: { organizationId: "org-id", workspaceRoot: "/mnt/workspaces", mountAwsS3Buckets: true },
    });

    await executor.run({
      code: "echo hi",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    // The developer's bucket/prefix/region/endpoint drive the mount, not the managed defaults.
    expect(daytonaCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      envVars: expect.objectContaining({
        AWS_ACCESS_KEY_ID: "scoped-access-key",
        AWS_REGION: "us-west-2",
        AWS_DEFAULT_REGION: "us-west-2",
      }),
    }));
    const assumeRoleInput = (stsSendMock.mock.calls.at(-1)?.[0] as { input: { RoleArn: string; ExternalId?: string; Policy?: string } }).input;
    expect(assumeRoleInput.RoleArn).toBe("arn:aws:iam::222:role/byo");
    expect(assumeRoleInput.ExternalId).toBe("ext-7");
    expect(assumeRoleInput.Policy).toContain("acme/agents/");
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      `mountpoint -q '/mnt/workspaces/${NS}' || sudo -E mount-s3 --uid "$(id -u)" --gid "$(id -g)" '--allow-delete' '--allow-overwrite' '--allow-other' '--prefix' 'agents/' '--region' 'us-west-2' '--endpoint-url' 'https://r2.example.com' 'acme' '/mnt/workspaces/${NS}'`,
    );
  });

  it("runs Vercel commands and adapts async command output", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({
      provider: "vercel",
      network: { mode: "restricted", allowDomains: ["api.example.com"], allowCidrs: ["10.0.0.0/8"] },
      options: { token: "tok", teamId: "team_1", projectId: "prj_1" },
    });

    const result = await executor.run({
      code: "echo hi",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "vercel", stdout: "vercel ok\n" });
    expect(vercelCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      token: "tok",
      teamId: "team_1",
      projectId: "prj_1",
      runtime: "node24",
      persistent: false,
      networkPolicy: { allow: ["api.example.com"], subnets: { allow: ["10.0.0.0/8"] } },
    }));
    expect(vercelRunCommandMock).toHaveBeenLastCalledWith(expect.objectContaining({
      cmd: "bash",
      args: ["-lc", "echo hi"],
      cwd: `/mnt/workspaces/${NS}`,
      timeoutMs: 30000,
    }));
    expect(vercelStopMock).toHaveBeenCalledTimes(1);
  });

  it("runs Vercel lifecycle hooks explicitly for persistent sandboxes", async () => {
    const { VercelSandboxExecutor } = await import("../functions/harness-processing/sandbox/vercel-executor.ts");
    const executor = new VercelSandboxExecutor({
      provider: "vercel",
      persistent: true,
      network: { mode: "allow-all" },
      onCreate: ["echo create > hook.txt"],
      onResume: ["echo resume >> hook.txt"],
      options: { token: "tok", teamId: "team_1", projectId: "prj_1" },
    });

    await executor.run({
      code: "cat hook.txt",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(vercelGetOrCreateMock).toHaveBeenCalled();
    expect(vercelCommandIncludes("echo create > hook.txt")).toBe(true);

    vercelRunCommandMock.mockClear();
    await executor.run({
      code: "cat hook.txt",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(vercelGetMock).toHaveBeenCalled();
    expect(vercelCommandIncludes("echo resume >> hook.txt")).toBe(true);
  });

});

describe("background job scripts", () => {
  it("builds a detached launch script with markers, a job cap, and parses status output", async () => {
    const { launchScript, statusScript, parseJobStatus } = await import("../functions/harness-processing/sandbox/jobs.ts");
    const launch = launchScript("/home/node/.jobs", "job_x", "/mnt/workspaces/ns", "echo hi", { maxConcurrentJobs: 10 });
    // The running marker records the boot id so a recreated sandbox is detectable.
    expect(launch).toContain("/proc/sys/kernel/random/boot_id");
    expect(launch).toContain("'/home/node/.jobs/job_x.running'");
    expect(launch).toContain("background job limit reached (10 concurrent)");
    expect(launch).toContain("setsid bash -c");
    // No callback => no completion POST baked into the wrapper.
    expect(launch).not.toContain("x-job-token");
    expect(statusScript("/home/node/.jobs", "job_x")).toContain("job_x.exit");
    expect(parseJobStatus("job_x", "done 0")).toEqual({ jobId: "job_x", state: "completed", exitCode: 0 });
    expect(parseJobStatus("job_x", "done 137")).toEqual({ jobId: "job_x", state: "failed", exitCode: 137 });
    expect(parseJobStatus("job_x", "running")).toEqual({ jobId: "job_x", state: "running" });
    expect(parseJobStatus("job_x", "unknown")).toEqual({ jobId: "job_x", state: "unknown" });
  });

  it("bakes a token-gated completion callback into the launch wrapper", async () => {
    const { launchScript } = await import("../functions/harness-processing/sandbox/jobs.ts");
    const launch = launchScript("/home/node/.jobs", "job_y", "/mnt/workspaces/ns", "echo hi", {
      maxConcurrentJobs: 10,
      callback: { url: "https://fn.example/sandbox-jobs/async_tool_1/complete", token: "tok-123" },
    });
    // The wrapper (and its callback) is base64-encoded so user code passes the
    // shell untouched — decode it to assert the callback is wired in.
    const encoded = launch.match(/printf %s '([A-Za-z0-9+/=]+)'/)?.[1];
    expect(encoded).toBeTruthy();
    const wrapper = Buffer.from(encoded!, "base64").toString("utf8");
    expect(wrapper).toContain("x-job-token");
    expect(wrapper).toContain("tok-123");
    expect(wrapper).toContain("https://fn.example/sandbox-jobs/async_tool_1/complete");
  });

  it("reports a job killed by sandbox recreation as failed, not running forever", async () => {
    const { statusScript } = await import("../functions/harness-processing/sandbox/jobs.ts");
    const status = statusScript("/home/node/.jobs", "job_x");
    // Boot-id mismatch or a dead pid (no exit recorded) both resolve to a failure code.
    expect(status).toContain("boot_id");
    expect(status).toContain('done 137');
    expect(status).toContain('kill -0');
  });
});

describe("isSandboxGoneError", () => {
  it("treats not-found / gone errors as terminal (drop the instance row)", async () => {
    const { isSandboxGoneError } = await import("../functions/harness-processing/sandbox/utils.ts");
    expect(isSandboxGoneError({ statusCode: 404 })).toBe(true);
    expect(isSandboxGoneError({ status: 410 })).toBe(true);
    expect(isSandboxGoneError(new Error("Sandbox not found"))).toBe(true);
    expect(isSandboxGoneError(new Error("sandbox already deleted"))).toBe(true);
  });

  it("treats auth / transient errors as non-terminal (keep the row, try next config)", async () => {
    const { isSandboxGoneError } = await import("../functions/harness-processing/sandbox/utils.ts");
    expect(isSandboxGoneError({ statusCode: 401 })).toBe(false);
    expect(isSandboxGoneError({ statusCode: 403 })).toBe(false);
    expect(isSandboxGoneError(new Error("connection reset"))).toBe(false);
    expect(isSandboxGoneError(undefined)).toBe(false);
  });
});

describe("isNoRunnersError", () => {
  it("matches provider capacity / no-runner errors", async () => {
    const { isNoRunnersError } = await import("../functions/harness-processing/sandbox/utils.ts");
    expect(isNoRunnersError(new Error("No available runners"))).toBe(true);
    expect(isNoRunnersError(new Error("no runner found for snapshot"))).toBe(true);
    expect(isNoRunnersError("No available runners")).toBe(true);
  });

  it("does not match unrelated errors", async () => {
    const { isNoRunnersError } = await import("../functions/harness-processing/sandbox/utils.ts");
    expect(isNoRunnersError(new Error("connection reset"))).toBe(false);
    expect(isNoRunnersError({ statusCode: 404 })).toBe(false);
    expect(isNoRunnersError(undefined)).toBe(false);
  });
});

describe("classifyVercelError", () => {
  it("turns 401/403 auth failures into an actionable VERCEL_TOKEN message", async () => {
    const { classifyVercelError } = await import("../functions/harness-processing/sandbox/vercel-executor.ts");
    // The SDK's documented bare-string form.
    expect(classifyVercelError(new Error("Status code 403 is not ok")).message).toContain("HTTP 403");
    expect(classifyVercelError(new Error("Status code 403 is not ok")).message).toContain("VERCEL_TOKEN");
    // A numeric status field on the thrown object.
    expect(classifyVercelError({ statusCode: 401 }).message).toContain("HTTP 401");
  });

  it("passes through unrelated errors without misclassifying stray 401/403 numbers", async () => {
    const { classifyVercelError } = await import("../functions/harness-processing/sandbox/vercel-executor.ts");
    const stray = classifyVercelError(new Error("operation failed after 403 attempts"));
    expect(stray.message).toBe("operation failed after 403 attempts");
    expect(stray.message).not.toContain("VERCEL_TOKEN");
    expect(classifyVercelError(new Error("connection reset")).message).toBe("connection reset");
  });
});

describe("workspaceNamespacePrefix", () => {
  it("prefixes namespaces with the sandbox mount root so harness and mount agree", async () => {
    const { workspaceNamespacePrefix } = await import("../functions/_shared/sandbox.ts");
    // Must match SandboxS3FilesAccessPoint.rootDirectories[].path in sst.config.ts.
    expect(workspaceNamespacePrefix("fs-abc")).toBe("fs-abc");
  });
});
