/**
 * Sandbox executor tests.
 * Cover provider selection + the single run() contract without invoking real
 * third-party services.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

const e2bRunMock = mock(async (_command: string, _options: Record<string, unknown>) => ({
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
}));
const e2bKillMock = mock(async () => {});
const e2bCreateMock = mock(async (_options: Record<string, unknown>) => ({
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
let lambdaPayload = {
  ok: true,
  runtime: "bash",
  exit_code: 0,
  timed_out: false,
  duration_ms: 5,
  stdout: "shell ok\n",
  stderr: "",
};
const lambdaSendMock = mock(async (_command: unknown) => ({
  Payload: new TextEncoder().encode(JSON.stringify(lambdaPayload)),
}));
const k8sCreateNamespacedCustomObjectMock = mock(async (_input: unknown) => ({}));
const k8sDeleteNamespacedCustomObjectMock = mock(async (_input: unknown) => ({}));
// Persistent path: default to "not found" so the executor creates the Sandbox.
let k8sGetSandboxResult: unknown = undefined;
const k8sGetNamespacedCustomObjectMock = mock(async (_input: unknown) => {
  if (k8sGetSandboxResult === undefined) {
    throw { code: 404, body: { reason: "NotFound" } };
  }
  return k8sGetSandboxResult;
});
const k8sPatchNamespacedCustomObjectMock = mock(async (_input: unknown) => ({}));
const k8sCreateNamespacedNetworkPolicyMock = mock(async (_input: unknown) => ({}));
const k8sReplaceNamespacedNetworkPolicyMock = mock(async (_input: unknown) => ({}));
const k8sDeleteNamespacedNetworkPolicyMock = mock(async (_input: unknown) => ({}));
const k8sReadNamespacedPodMock = mock(async (input: { name: string; namespace: string }) => ({
  metadata: { name: input.name, namespace: input.namespace },
  status: { conditions: [{ type: "Ready", status: "True" }] },
}));
const k8sExecMock = mock(async (
  _namespace: string,
  _podName: string,
  _container: string,
  _command: string[],
  _stdout: unknown,
  _stderr: unknown,
  _stdin: unknown,
  _tty: boolean,
  statusCallback: (status: { status: string }) => void,
) => {
  statusCallback({ status: "Success" });
  return {
    on(event: string, callback: () => void) {
      if (event === "close") queueMicrotask(callback);
    },
  };
});

mock.module("e2b", () => ({
  Sandbox: {
    create: e2bCreateMock,
  },
}));

mock.module("@daytona/sdk", () => ({
  Daytona: class {
    constructor(_options: Record<string, unknown>) {}

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

mock.module("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send = lambdaSendMock;
  },
  InvokeCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetFunctionUrlConfigCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
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

mock.module("@kubernetes/client-node", () => ({
  KubeConfig: class {
    loadFromDefault() {}
    loadFromString(_raw: string) {}
    makeApiClient(api: new () => unknown) {
      return new api();
    }
  },
  CoreV1Api: class {
    readNamespacedPod = k8sReadNamespacedPodMock;
  },
  CustomObjectsApi: class {
    createNamespacedCustomObject = k8sCreateNamespacedCustomObjectMock;
    deleteNamespacedCustomObject = k8sDeleteNamespacedCustomObjectMock;
    getNamespacedCustomObject = k8sGetNamespacedCustomObjectMock;
    patchNamespacedCustomObject = k8sPatchNamespacedCustomObjectMock;
  },
  NetworkingV1Api: class {
    createNamespacedNetworkPolicy = k8sCreateNamespacedNetworkPolicyMock;
    replaceNamespacedNetworkPolicy = k8sReplaceNamespacedNetworkPolicyMock;
    deleteNamespacedNetworkPolicy = k8sDeleteNamespacedNetworkPolicyMock;
  },
  Exec: class {
    constructor(_kc: unknown) {}
    exec = k8sExecMock;
  },
}));

beforeEach(() => {
  process.env.AWS_ACCESS_KEY_ID = "test-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.AWS_SESSION_TOKEN = "test-session-token";
  process.env.AWS_REGION = "eu-central-1";
  process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::123456789012:role/sandbox-s3mount";
  process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
  process.env.SKILLS_BUCKET_NAME = "skills-bucket";
  process.env.PERSISTENT_SANDBOX_INSTANCE_TABLE_NAME = "persistent-sandbox-instance";
  process.env.SANDBOX_FN_MOUNT_NET = "sandbox-mount-net";
  process.env.SANDBOX_FN_MOUNT_NONET = "sandbox-mount-nonet";
  process.env.SANDBOX_FN_NOMOUNT_NET = "sandbox-nomount-net";
  process.env.SANDBOX_FN_NOMOUNT_NONET = "sandbox-nomount-nonet";
  delete process.env.KUBERNETES_SANDBOX_SERVICE_ACCOUNT;
  e2bRunMock.mockClear();
  e2bKillMock.mockClear();
  e2bCreateMock.mockClear();
  daytonaExecuteCommandMock.mockClear();
  daytonaDeleteMock.mockClear();
  daytonaCreateMock.mockClear();
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
  lambdaSendMock.mockClear();
  k8sCreateNamespacedCustomObjectMock.mockClear();
  k8sDeleteNamespacedCustomObjectMock.mockClear();
  k8sGetNamespacedCustomObjectMock.mockClear();
  k8sPatchNamespacedCustomObjectMock.mockClear();
  k8sCreateNamespacedNetworkPolicyMock.mockClear();
  k8sReplaceNamespacedNetworkPolicyMock.mockClear();
  k8sDeleteNamespacedNetworkPolicyMock.mockClear();
  k8sGetSandboxResult = undefined;
  k8sReadNamespacedPodMock.mockClear();
  k8sExecMock.mockClear();
  lambdaPayload = {
    ok: true,
    runtime: "bash",
    exit_code: 0,
    timed_out: false,
    duration_ms: 5,
    stdout: "shell ok\n",
    stderr: "",
  };
});

const NS = "fs-0123456789abcdef0123456789abcdef01234567";

describe("createSandboxExecutor", () => {
  it("creates the built-in Lambda executor by default", () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    expect(createSandboxExecutor({}).constructor.name).toBe("LambdaSandboxExecutor");
  });

  it("creates E2B, Daytona, Kubernetes, and Vercel executor adapters", () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    expect(createSandboxExecutor({ provider: "e2b" }).constructor.name).toBe("E2BSandboxExecutor");
    expect(createSandboxExecutor({ provider: "daytona" }).constructor.name).toBe("DaytonaSandboxExecutor");
    expect(createSandboxExecutor({ provider: "kubernetes" }).constructor.name).toBe("KubernetesSandboxExecutor");
    expect(createSandboxExecutor({ provider: "vercel" }).constructor.name).toBe("VercelSandboxExecutor");
  });

  it("selects the mounted (no-internet) lambda when a namespace is present", async () => {
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
    const command = lambdaSendMock.mock.calls[0]![0] as { input: { FunctionName: string; Payload: Uint8Array } };
    expect(command.input.FunctionName).toBe("sandbox-mount-nonet");
    expect(JSON.parse(new TextDecoder().decode(command.input.Payload))).toMatchObject({
      runtime: "bash",
      code: "echo ok",
      namespace: NS,
      workspace_root: "/mnt/workspaces",
      timeout_ms: 30000,
    });
  });

  it("selects the no-mount internet lambda when stateless + allow-all network", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda", network: { mode: "allow-all" } });

    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    const command = lambdaSendMock.mock.calls[0]![0] as { input: { FunctionName: string; Payload: Uint8Array } };
    expect(command.input.FunctionName).toBe("sandbox-nomount-net");
    expect(JSON.parse(new TextDecoder().decode(command.input.Payload)).namespace).toBeUndefined();
  });

  it("maps restricted lambda network to the no-internet slot", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({
      provider: "lambda",
      network: { mode: "restricted", allowDomains: ["api.example.com"], allowCidrs: ["10.0.0.0/8"] },
    });

    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    const command = lambdaSendMock.mock.calls[0]![0] as { input: { FunctionName: string } };
    expect(command.input.FunctionName).toBe("sandbox-nomount-nonet");
  });

  it("applies the harness output limit to lambda responses", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    lambdaPayload = {
      ...lambdaPayload,
      stdout: "abcdef",
      stderr: "uvwxyz",
    };
    const executor = createSandboxExecutor({ provider: "lambda" });

    const result = await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 3 });

    expect(result.stdout).toBe("abc\n[output truncated]");
    expect(result.stderr).toBe("uvw\n[output truncated]");
    expect(result.truncated).toBe(true);
  });

  it("runs E2B commands as-is in the workspace directory", async () => {
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
    expect(e2bRunMock).toHaveBeenCalledWith(
      "mkdir -p notes && echo hi > notes/a.txt && cat notes/a.txt",
      {
        cwd: `/workspace/${NS}`,
        timeoutMs: 30000,
        envs: { MY_API_BASE: "https://api.example.com" },
      },
    );
    expect(e2bKillMock).toHaveBeenCalledTimes(1);
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
        AWS_REGION: "eu-central-1",
        AWS_DEFAULT_REGION: "eu-central-1",
      },
    }));
    // The sandbox gets role-scoped credentials, never the harness runtime's own.
    const assumeRoleInput = (stsSendMock.mock.calls.at(-1)?.[0] as { input: { RoleArn: string; Policy?: string } }).input;
    expect(assumeRoleInput.RoleArn).toBe("arn:aws:iam::123456789012:role/sandbox-s3mount");
    expect(assumeRoleInput.Policy).toContain(`workspace-bucket/sandbox/${NS}/`);
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      `mountpoint -q '/mnt/workspaces/${NS}' || sudo -E mount-s3 --uid "$(id -u)" --gid "$(id -g)" '--allow-delete' '--allow-overwrite' '--allow-other' '--prefix' 'sandbox/${NS}/' '--region' 'eu-central-1' 'workspace-bucket' '/mnt/workspaces/${NS}'`,
    );
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      "echo hi && ls",
      `/mnt/workspaces/${NS}`,
      undefined,
      45,
    );
    expect(daytonaDeleteMock).toHaveBeenCalledTimes(1);
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

  it("uses Vercel native create/resume lifecycle callbacks for persistent sandboxes", async () => {
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
    expect((vercelRunCommandMock.mock.calls[0]![0] as { args: string[] }).args[1]).toContain("echo create > hook.txt");

    vercelRunCommandMock.mockClear();
    await executor.run({
      code: "cat hook.txt",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });
    expect(vercelGetMock).toHaveBeenCalled();
    expect((vercelRunCommandMock.mock.calls[0]![0] as { args: string[] }).args[1]).toContain("echo resume >> hook.txt");
  });

  it("uses the workspace service account for Kubernetes S3 mounts by default", async () => {
    const { KubernetesSandboxExecutor } = await import("../functions/harness-processing/sandbox/kubernetes-executor.ts");
    const executor = new KubernetesSandboxExecutor({
      provider: "kubernetes",
      options: {
        mountAwsS3Buckets: true,
        workspaceRoot: "/mnt/workspaces",
      },
    });

    const result = await executor.run({
      code: "echo hi",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 45,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "kubernetes" });
    const createInput = k8sCreateNamespacedCustomObjectMock.mock.calls[0]![0] as {
      body: { spec: { podTemplate: { spec: { serviceAccountName?: string; containers: Array<{ securityContext?: unknown }> } } } };
    };
    const podSpec = createInput.body.spec.podTemplate.spec;
    expect(podSpec.serviceAccountName).toBe("agent-sandbox-workspace");
    expect(podSpec.containers[0]?.securityContext).toEqual({ privileged: true, runAsUser: 0 });
    expect(k8sExecMock.mock.calls.map((call) => call[3])).toContainEqual([
      "bash",
      "-lc",
      expect.stringContaining("mount-s3 --uid 1000 --gid 1000"),
    ]);
  });

  it("reserves a persistent Kubernetes sandbox with a home PVC and never deletes it", async () => {
    const { KubernetesSandboxExecutor } = await import("../functions/harness-processing/sandbox/kubernetes-executor.ts");
    const executor = new KubernetesSandboxExecutor({
      provider: "kubernetes",
      persistent: true,
      lifecycle: { idleTimeoutSeconds: 1800 },
      options: { mountAwsS3Buckets: true, workspaceRoot: "/mnt/workspaces", persistentDiskGb: 20 },
    });

    const result = await executor.run({
      code: "echo hi",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "kubernetes" });
    expect(k8sCreateNamespacedCustomObjectMock).toHaveBeenCalledTimes(1);
    expect(k8sDeleteNamespacedCustomObjectMock).not.toHaveBeenCalled();
    const body = (k8sCreateNamespacedCustomObjectMock.mock.calls[0]![0] as { body: Record<string, any> }).body;
    expect(body.metadata.name).toMatch(/^fp-p-/);
    expect(body.metadata.labels).toEqual({ "beeblast.co/persistent": "true" });
    expect(body.metadata.annotations["beeblast.co/idle-timeout-seconds"]).toBe("1800");
    expect(body.spec.replicas).toBe(1);
    expect(body.spec.shutdownPolicy).toBe("Delete");
    expect(typeof body.spec.shutdownTime).toBe("string");
    expect(body.spec.volumeClaimTemplates[0].metadata.name).toBe("home");
    expect(body.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe("20Gi");
    const container = body.spec.podTemplate.spec.containers[0];
    expect(container.volumeMounts).toEqual([{ name: "home", mountPath: "/home/node" }]);
    expect(container.env).toEqual(expect.arrayContaining([{ name: "HOME", value: "/home/node" }]));
    expect(k8sPatchNamespacedCustomObjectMock).toHaveBeenCalled();
  });

  it("skips the home PVC for an ephemeralHome persistent sandbox but keeps HOME", async () => {
    const { KubernetesSandboxExecutor } = await import("../functions/harness-processing/sandbox/kubernetes-executor.ts");
    const executor = new KubernetesSandboxExecutor({
      provider: "kubernetes",
      persistent: true,
      ephemeralHome: true,
      options: {},
    });

    await executor.run({
      code: "echo hi",
      reservationKey: "custom-tool:acct_1:tool_1",
      workspaceRoot: "/tmp",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    const body = (k8sCreateNamespacedCustomObjectMock.mock.calls[0]![0] as { body: Record<string, any> }).body;
    expect(body.spec.replicas).toBe(1);
    // Reserved + reused, but no cloud volume to provision: the cold-start win.
    expect(body.spec.volumeClaimTemplates).toBeUndefined();
    const container = body.spec.podTemplate.spec.containers[0];
    expect(container.volumeMounts).toBeUndefined();
    expect(body.spec.podTemplate.spec.securityContext).toBeUndefined();
    expect(container.env).toEqual(expect.arrayContaining([{ name: "HOME", value: "/home/node" }]));
  });

  it("creates a Kubernetes deny-all NetworkPolicy by default", async () => {
    const { KubernetesSandboxExecutor } = await import("../functions/harness-processing/sandbox/kubernetes-executor.ts");
    const executor = new KubernetesSandboxExecutor({ provider: "kubernetes" });

    await executor.run({
      code: "echo hi",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    const policy = k8sCreateNamespacedNetworkPolicyMock.mock.calls[0]![0] as {
      body: { spec: { podSelector: { matchLabels: Record<string, string> }; egress: unknown[] } };
    };
    expect(policy.body.spec.podSelector.matchLabels["beeblast.co/sandbox-name"]).toMatch(/^fp-/);
    expect(policy.body.spec.egress).toEqual([]);
  });

  it("resumes an idled persistent sandbox by scaling replicas 0 -> 1", async () => {
    const { KubernetesSandboxExecutor } = await import("../functions/harness-processing/sandbox/kubernetes-executor.ts");
    k8sGetSandboxResult = { spec: { replicas: 0 } };
    const executor = new KubernetesSandboxExecutor({
      provider: "kubernetes",
      persistent: true,
      options: { mountAwsS3Buckets: true, workspaceRoot: "/mnt/workspaces" },
    });

    await executor.run({
      code: "echo hi",
      namespace: NS,
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(k8sCreateNamespacedCustomObjectMock).not.toHaveBeenCalled();
    const scalePatch = k8sPatchNamespacedCustomObjectMock.mock.calls.find(
      (call) => Array.isArray((call[0] as { body?: unknown }).body) &&
        ((call[0] as { body: Array<{ path?: string }> }).body)[0]?.path === "/spec/replicas",
    );
    expect(scalePatch).toBeTruthy();
    const scaleBody = (scalePatch![0] as { body: Array<{ value: number }> }).body;
    expect(scaleBody[0]?.value).toBe(1);
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

describe("workspaceNamespacePrefix", () => {
  it("prefixes namespaces with the sandbox mount root so harness and mount agree", async () => {
    const { workspaceNamespacePrefix } = await import("../functions/_shared/sandbox.ts");
    // Must match SandboxS3FilesAccessPoint.rootDirectories[].path in sst.config.ts.
    expect(workspaceNamespacePrefix("fs-abc")).toBe("sandbox/fs-abc");
  });
});
