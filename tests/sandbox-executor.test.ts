/**
 * Workspace sandbox executor tests.
 * Cover provider selection without invoking real third-party services.
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

const daytonaExecuteCommandMock = mock(async (_command: string, _cwd: string, _env?: unknown, _timeout?: number) => ({
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
const lambdaSendMock = mock(async (_command: unknown) => ({
  Payload: new TextEncoder().encode(JSON.stringify({
    ok: true,
    exitCode: 0,
    stdout: "shell ok\n",
    stderr: "",
    durationMs: 5,
  })),
}));

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

beforeEach(() => {
  process.env.AWS_ACCESS_KEY_ID = "test-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.AWS_SESSION_TOKEN = "test-session-token";
  process.env.AWS_REGION = "eu-central-1";
  process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
  process.env.SKILLS_BUCKET_NAME = "skills-bucket";
  e2bRunMock.mockClear();
  e2bKillMock.mockClear();
  e2bCreateMock.mockClear();
  daytonaExecuteCommandMock.mockClear();
  daytonaDeleteMock.mockClear();
  daytonaCreateMock.mockClear();
  lambdaSendMock.mockClear();
  process.env.SANDBOX_BASH_FUNCTION_NAME = "sandbox-bash";
});

describe("createWorkspaceSandboxExecutor", () => {
  it("creates the built-in Lambda executor by default", () => {
    const { createWorkspaceSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createWorkspaceSandboxExecutor({});
    expect(executor.constructor.name).toBe("LambdaWorkspaceSandboxExecutor");
  });

  it("creates E2B and Daytona executor adapters", () => {
    const { createWorkspaceSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    expect(createWorkspaceSandboxExecutor({ provider: "e2b" }).constructor.name)
      .toBe("E2BWorkspaceSandboxExecutor");
    expect(createWorkspaceSandboxExecutor({ provider: "daytona" }).constructor.name)
      .toBe("DaytonaWorkspaceSandboxExecutor");
  });

  it("runs Lambda shell commands through the configured bash sandbox", async () => {
    const { createWorkspaceSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createWorkspaceSandboxExecutor({
      options: {
        bashFunctionName: "custom-bash",
        networkAccess: "public",
      },
    });

    const result = await executor.runShell!({
      namespace: "fs-0123456789abcdef0123456789abcdef01234567",
      shell: "echo ok",
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "lambda", stdout: "shell ok\n" });
    const command = lambdaSendMock.mock.calls[0]![0] as { input: { FunctionName: string; Payload: Uint8Array } };
    expect(command.input.FunctionName).toBe("custom-bash");
    expect(JSON.parse(new TextDecoder().decode(command.input.Payload))).toMatchObject({
      runtime: "shell",
      shell: "echo ok",
      networkAccess: "public",
    });
  });

  it("reads a directory straight from the mount through the bash sandbox", async () => {
    const { createWorkspaceSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createWorkspaceSandboxExecutor({ options: { bashFunctionName: "custom-bash" } });

    lambdaSendMock.mockResolvedValueOnce({
      Payload: new TextEncoder().encode(JSON.stringify({
        ok: true,
        files: [{ path: "SKILL.md", base64: "U0tJTEw=" }],
      })),
    });

    const result = await executor.readDirectory!({
      namespace: "fs-0123456789abcdef0123456789abcdef01234567",
      path: ".claude/skills/demo",
      workspaceRoot: "/mnt/workspaces",
    });

    expect(result).toMatchObject({ ok: true, provider: "lambda", files: [{ path: "SKILL.md", base64: "U0tJTEw=" }] });
    const command = lambdaSendMock.mock.calls[0]![0] as { input: { FunctionName: string; Payload: Uint8Array } };
    expect(command.input.FunctionName).toBe("custom-bash");
    expect(JSON.parse(new TextDecoder().decode(command.input.Payload))).toMatchObject({
      runtime: "read-dir",
      path: ".claude/skills/demo",
      namespace: "fs-0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("runs E2B commands from the configured native mounted namespace path", async () => {
    const { createWorkspaceSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createWorkspaceSandboxExecutor({
      provider: "e2b",
      options: {
        workspaceRoot: "/workspace",
        template: "mounted-template",
      },
    });

    const result = await executor.runFile({
      runtime: "node",
      namespace: "fs-0123456789abcdef0123456789abcdef01234567",
      entryPath: "/scripts/main.js",
      args: ["--mode", "fast value"],
      workspaceRoot: "/workspace",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "e2b", stdout: "ok\n" });
    expect(e2bCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      template: "mounted-template",
    }));
    expect(e2bRunMock).toHaveBeenCalledWith(
      "'node' 'scripts/main.js' '--mode' 'fast value'",
      {
        cwd: "/workspace/fs-0123456789abcdef0123456789abcdef01234567",
        timeoutMs: 30000,
      },
    );
    expect(e2bKillMock).toHaveBeenCalledTimes(1);
  });

  it("runs Daytona commands from the configured native mounted namespace path", async () => {
    const { createWorkspaceSandboxExecutor } = require("../functions/harness-processing/sandbox/index.ts");
    const executor = createWorkspaceSandboxExecutor({
      provider: "daytona",
      options: {
        organizationId: "org-id",
        workspaceRoot: "/mnt/workspaces",
        snapshot: "fuse-s3",
        mountAwsS3Buckets: true,
      },
    });

    const result = await executor.runFile({
      runtime: "python",
      namespace: "fs-0123456789abcdef0123456789abcdef01234567",
      entryPath: "/analysis.py",
      args: ["sample.wav"],
      workspaceRoot: "/mnt/workspaces",
      timeoutSeconds: 45,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, provider: "daytona", stdout: "ok\n" });
    expect(daytonaCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: "fuse-s3",
      language: "python",
      envVars: {
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
        AWS_SESSION_TOKEN: "test-session-token",
        AWS_REGION: "eu-central-1",
        AWS_DEFAULT_REGION: "eu-central-1",
      },
    }));
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith("sudo mkdir -p '/mnt/workspaces'");
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      "sudo chown \"$(id -u)\":\"$(id -g)\" '/mnt/workspaces'",
    );
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      "sudo -E mount-s3 --uid \"$(id -u)\" --gid \"$(id -g)\" '--allow-delete' '--allow-overwrite' '--allow-other' '--prefix' 'sandbox/' '--region' 'eu-central-1' 'workspace-bucket' '/mnt/workspaces'",
    );
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith("sudo mkdir -p '/mnt/skills'");
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      "sudo chown \"$(id -u)\":\"$(id -g)\" '/mnt/skills'",
    );
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      "sudo -E mount-s3 --uid \"$(id -u)\" --gid \"$(id -g)\" '--allow-delete' '--allow-overwrite' '--allow-other' '--region' 'eu-central-1' 'skills-bucket' '/mnt/skills'",
    );
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      "'python3' 'analysis.py' 'sample.wav'",
      "/mnt/workspaces/fs-0123456789abcdef0123456789abcdef01234567",
      undefined,
      45,
    );
    expect(daytonaDeleteMock).toHaveBeenCalledTimes(1);
  });
});

describe("workspaceNamespacePrefix", () => {
  it("prefixes namespaces with the sandbox mount root so harness and mount agree", async () => {
    const { workspaceNamespacePrefix } = await import("../functions/_shared/sandbox.ts");
    // Must match SandboxS3FilesAccessPoint.rootDirectories[].path in sst.config.ts.
    expect(workspaceNamespacePrefix("fs-abc")).toBe("sandbox/fs-abc");
  });
});
