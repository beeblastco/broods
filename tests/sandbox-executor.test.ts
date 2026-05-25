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
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith("mkdir -p '/mnt/workspaces'");
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      "'mount-s3' '--allow-delete' '--allow-overwrite' '--region' 'eu-central-1' 'workspace-bucket' '/mnt/workspaces'",
    );
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith("mkdir -p '/mnt/skills'");
    expect(daytonaExecuteCommandMock).toHaveBeenCalledWith(
      "'mount-s3' '--allow-delete' '--allow-overwrite' '--region' 'eu-central-1' 'skills-bucket' '/mnt/skills'",
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
