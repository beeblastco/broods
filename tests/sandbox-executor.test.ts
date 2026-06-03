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
  process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
  process.env.SKILLS_BUCKET_NAME = "skills-bucket";
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
  lambdaSendMock.mockClear();
  k8sCreateNamespacedCustomObjectMock.mockClear();
  k8sDeleteNamespacedCustomObjectMock.mockClear();
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

  it("creates E2B, Daytona, and Kubernetes executor adapters", () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    expect(createSandboxExecutor({ provider: "e2b" }).constructor.name).toBe("E2BSandboxExecutor");
    expect(createSandboxExecutor({ provider: "daytona" }).constructor.name).toBe("DaytonaSandboxExecutor");
    expect(createSandboxExecutor({ provider: "kubernetes" }).constructor.name).toBe("KubernetesSandboxExecutor");
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

  it("selects the no-mount internet lambda when stateless + internet on", async () => {
    const { createSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createSandboxExecutor({ provider: "lambda", internet: true });

    await executor.run({ code: "echo ok", timeoutSeconds: 30, outputLimitBytes: 4096 });
    const command = lambdaSendMock.mock.calls[0]![0] as { input: { FunctionName: string; Payload: Uint8Array } };
    expect(command.input.FunctionName).toBe("sandbox-nomount-net");
    expect(JSON.parse(new TextDecoder().decode(command.input.Payload)).namespace).toBeUndefined();
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
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
        AWS_SESSION_TOKEN: "test-session-token",
        AWS_REGION: "eu-central-1",
        AWS_DEFAULT_REGION: "eu-central-1",
      },
    }));
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      `sudo -E mount-s3 --uid "$(id -u)" --gid "$(id -g)" '--allow-delete' '--allow-overwrite' '--allow-other' '--prefix' 'sandbox/${NS}/' '--region' 'eu-central-1' 'workspace-bucket' '/mnt/workspaces/${NS}'`,
    );
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      "echo hi && ls",
      `/mnt/workspaces/${NS}`,
      undefined,
      45,
    );
    expect(daytonaDeleteMock).toHaveBeenCalledTimes(1);
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
});

describe("workspaceNamespacePrefix", () => {
  it("prefixes namespaces with the sandbox mount root so harness and mount agree", async () => {
    const { workspaceNamespacePrefix } = await import("../functions/_shared/sandbox.ts");
    // Must match SandboxS3FilesAccessPoint.rootDirectories[].path in sst.config.ts.
    expect(workspaceNamespacePrefix("fs-abc")).toBe("sandbox/fs-abc");
  });
});
