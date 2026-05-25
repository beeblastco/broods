/**
 * Filesystem tool tests.
 * Cover shell delegation to the mounted Lambda sandbox.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const ORIGINAL_ENV = { ...process.env };

const lambdaSendMock = mock(async (command: { input: { FunctionName: string; Payload: Uint8Array } }) => {
  const payload = JSON.parse(new TextDecoder().decode(command.input.Payload));
  if (command.input.FunctionName === "sandbox-python") {
    return {
      Payload: new TextEncoder().encode(JSON.stringify({
        ok: true,
        runtime: "python",
        exitCode: 0,
        stdout: "hello from python\n",
        stderr: "",
        durationMs: 12,
      })),
    };
  }

  return {
    Payload: new TextEncoder().encode(JSON.stringify({
      ok: true,
      exitCode: 0,
      stdout: `shell:${payload.shell}\n`,
      stderr: "",
      durationMs: 8,
    })),
  };
});

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
  process.env.AWS_REGION = "eu-central-1";
  process.env.SANDBOX_BASH_FUNCTION_NAME = "sandbox-bash";
  process.env.SANDBOX_PYTHON_FUNCTION_NAME = "sandbox-python";
  lambdaSendMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function createToolContext(namespace = "fs-0123456789abcdef0123456789abcdef01234567", config: Record<string, unknown> = {}) {
  return {
    conversationKey: "test-conversation",
    filesystemNamespace: namespace,
    config,
    modelProviderName: "google",
    modelProvider: {},
  } as never;
}

async function executeShell(shell: string, config: Record<string, unknown> = {}) {
  const { default: filesystemTool } = await import("../functions/harness-processing/tools/filesystem.tool.ts");
  const tools = filesystemTool(createToolContext(undefined, config));
  const filesystem = tools.filesystem!;
  return (filesystem as unknown as { execute(input: { shell: string }): Promise<{ type: string; value: any }> }).execute({ shell });
}

function lastLambdaInput() {
  const command = lambdaSendMock.mock.calls.at(-1)?.[0] as { input: { FunctionName: string; Payload: Uint8Array } };
  return {
    functionName: command.input.FunctionName,
    payload: JSON.parse(new TextDecoder().decode(command.input.Payload)),
  };
}

describe("filesystem tool", () => {
  it("delegates shell commands to the bash sandbox Lambda", async () => {
    const result = await executeShell("mkdir -p notes && echo hello > notes/a.txt && cat notes/a.txt");

    expect(result).toEqual({
      type: "text",
      value: "shell:mkdir -p notes && echo hello > notes/a.txt && cat notes/a.txt\n",
    });
    expect(lastLambdaInput()).toMatchObject({
      functionName: "sandbox-bash",
      payload: {
        runtime: "shell",
        namespace: "fs-0123456789abcdef0123456789abcdef01234567",
        shell: "mkdir -p notes && echo hello > notes/a.txt && cat notes/a.txt",
        workspaceRoot: "/mnt/workspaces",
        timeoutSeconds: 30,
        outputLimitBytes: 65536,
        networkAccess: "disabled",
      },
    });
  });

  it("passes configured bash function name, workspace root, limits, and network access", async () => {
    await executeShell("curl https://example.com", {
      timeout: 45,
      outputLimitBytes: 4096,
      options: {
        bashFunctionName: "custom-bash",
        workspaceRoot: "/workspace",
        networkAccess: "public",
      },
    });

    expect(lastLambdaInput()).toMatchObject({
      functionName: "custom-bash",
      payload: {
        shell: "curl https://example.com",
        workspaceRoot: "/workspace",
        timeoutSeconds: 45,
        outputLimitBytes: 4096,
        networkAccess: "public",
      },
    });
  });

  it("returns bash sandbox stderr with stdout for shell commands", async () => {
    lambdaSendMock.mockResolvedValueOnce({
      Payload: new TextEncoder().encode(JSON.stringify({
        ok: false,
        exitCode: 1,
        stdout: "partial\n",
        stderr: "cat: missing: No such file or directory\n",
        durationMs: 8,
      })),
    });

    const result = await executeShell("cat missing");

    expect(result).toEqual({
      type: "text",
      value: "partial\ncat: missing: No such file or directory\n",
    });
  });

  it("routes Python file execution to the existing Python sandbox", async () => {
    const result = await executeShell("python3 script.py --mode fast");

    expect(result.type).toBe("json");
    expect(result.value).toMatchObject({
      output: {
        stdout: "hello from python\n",
        stderr: "",
        artifacts: [],
      },
      status: {
        ok: true,
        runtime: "python",
        provider: "lambda",
        exitCode: 0,
      },
    });
    expect(lastLambdaInput()).toMatchObject({
      functionName: "sandbox-python",
      payload: {
        runtime: "python",
        namespace: "fs-0123456789abcdef0123456789abcdef01234567",
        entryPath: "/script.py",
        args: ["--mode", "fast"],
      },
    });
  });

  it("rejects inline Python execution before invoking Lambda", async () => {
    const result = await executeShell("python3 -c 'print(1)'");

    expect(result).toEqual({
      type: "error-text",
      value: "Execution command must reference one workspace file and cannot use inline flags",
    });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });
});
