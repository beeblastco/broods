/**
 * Sandbox tool tests.
 * Cover the Claude-Code-style tool set (bash/read/write/edit/glob/grep): the
 * sandbox-backed path compiling to bash on the AWS Lambda MicroVM sandbox, the
 * read-only mount default, and the S3-direct opt-out path.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

// The sandbox now runs as an AWS Lambda MicroVM: control-plane calls go through the
// SDK client, and the exec request is an HTTPS POST to the VM endpoint. Echo the
// request code back as stdout so bash returns "shell:<code>".
const microvmSendMock = mock(async (command: { _type?: string }) => {
  switch (command?._type) {
    case "RunMicrovm":
      return { microvmId: "microvm-1", endpoint: "microvm-1.lambda-microvm.us-east-1.on.aws", state: "PENDING" };
    case "CreateMicrovmAuthToken":
      return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
    default:
      return {};
  }
});
const microvmFetchMock = mock(async (_url: string, init: { body: string }) => {
  const payload = JSON.parse(init.body);
  return new Response(JSON.stringify({
    ok: true,
    runtime: payload.runtime,
    exit_code: 0,
    timed_out: false,
    duration_ms: 8,
    stdout: `shell:${payload.code}`,
    stderr: "",
  }), { status: 200, headers: { "content-type": "application/json" } });
});
function microvmCommand(type: string) {
  return class {
    input: unknown;
    _type = type;
    constructor(input: unknown) {
      this.input = input;
    }
  };
}

mock.module("@aws-sdk/client-lambda-microvms", () => ({
  LambdaMicrovms: class {
    send = microvmSendMock;
  },
  RunMicrovmCommand: microvmCommand("RunMicrovm"),
  CreateMicrovmAuthTokenCommand: microvmCommand("CreateMicrovmAuthToken"),
  TerminateMicrovmCommand: microvmCommand("TerminateMicrovm"),
  GetMicrovmCommand: microvmCommand("GetMicrovm"),
  SuspendMicrovmCommand: microvmCommand("SuspendMicrovm"),
  ResumeMicrovmCommand: microvmCommand("ResumeMicrovm"),
}));

// Read-only (S3-direct) path stubs for sandbox-less workspaces.
const readS3TextMock = mock(async (_bucket: string, _key: string) => "");
const listS3PrefixMock = mock(async (_bucket: string, _prefix: string) =>
  [] as Array<{ key: string; lastModified?: string }>);

mock.module("../functions/_shared/s3.ts", () => ({
  readS3Text: readS3TextMock,
  listS3Prefix: listS3PrefixMock,
  isMissingS3Error: (error: unknown) =>
    Boolean(error && typeof error === "object" && (error as { name?: string }).name === "NoSuchKey"),
  // Full surface so transitive importers keep working (mock.module replaces the module).
  readS3Bytes: mock(async () => new Uint8Array()),
  writeS3Object: mock(async () => 0),
  s3ObjectExists: mock(async () => false),
  deleteS3Object: mock(async () => {}),
  deleteS3Prefix: mock(async () => 0),
  copyS3Object: mock(async () => {}),
  ensureS3DirectoryMarkers: mock(async () => {}),
  getS3ObjectUrl: mock(async () => "https://example.test/tool.mjs"),
}));

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  process.env.MICROVM_IMAGE_IDENTIFIER = "arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox";
  process.env.MICROVM_EGRESS_NETWORK_CONNECTOR_ARN = "arn:aws:lambda:us-east-1:123456789012:network-connector:vpc-egress";
  process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-results";
  globalThis.fetch = microvmFetchMock as unknown as typeof fetch;
  microvmSendMock.mockClear();
  microvmFetchMock.mockClear();
  readS3TextMock.mockClear();
  listS3PrefixMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

const NS = "fs-0123456789abcdef0123456789abcdef01234567";

// Sandbox-backed workspace context (file tools route through the mount).
function workspaceCtx(sandboxOverrides: Record<string, unknown> = {}) {
  return {
    workspaces: [{
      name: "notes",
      workspaceId: "ws_a",
      namespace: NS,
      config: { storage: { provider: "s3" } },
      sandbox: { provider: "lambda", network: { mode: "allow-all" }, ...sandboxOverrides },
    }],
  } as never;
}

// Stateless bash context (no workspace): runs ephemerally on the agent sandbox.
function statelessCtx(sandboxOverrides: Record<string, unknown> = {}) {
  return {
    workspaces: [],
    statelessSandbox: { provider: "lambda", network: { mode: "allow-all" }, ...sandboxOverrides },
    statelessPermissionMode: "ask",
  } as never;
}

// Read-only workspace, `sandbox: null` opt-out (no readMount => served directly from S3).
function readonlyCtx() {
  return {
    workspaces: [{ name: "ro", workspaceId: "ws_ro", namespace: NS, config: { storage: { provider: "s3" } } }],
  } as never;
}

// Read-only workspace, default behavior: read/glob run through a service-managed
// read-only mount (readMount) so they see committed writes immediately.
function readonlyMountCtx() {
  return {
    workspaces: [{
      name: "ro",
      workspaceId: "ws_ro",
      namespace: NS,
      config: { storage: { provider: "s3" } },
      readMount: { provider: "lambda", network: { mode: "deny-all" } },
    }],
  } as never;
}

// The compiled bash the tool sent lands in the body of the exec POST to the VM.
function lastSandboxExec() {
  const call = microvmFetchMock.mock.calls.at(-1) as [string, { body: string }] | undefined;
  return { payload: JSON.parse(call![1].body) };
}

async function tool(name: "bash" | "read" | "write" | "edit" | "glob" | "grep", ctx: never) {
  const mod = await import(`../functions/harness-processing/tools/${name}.tool.ts`);
  return mod.default(ctx)[name] as { execute(input: Record<string, unknown>): Promise<{ type: string; value: string }> };
}

describe("sandbox tool set", () => {
  it("bash routes to the mounted internet function when a workspace is attached", async () => {
    const bash = await tool("bash", workspaceCtx());
    const result = await bash.execute({ command: "echo hi" });
    expect(result).toEqual({ type: "text", value: "shell:echo hi" });
    expect(lastSandboxExec()).toMatchObject({
      payload: { runtime: "bash", namespace: NS, code: "echo hi", workspace_root: "/mnt/workspaces" },
    });
  });

  it("runs a stateless MicroVM (no namespace) when no workspace is attached", async () => {
    const bash = await tool("bash", statelessCtx());
    await bash.execute({ command: "echo hi" });
    expect(lastSandboxExec().payload.namespace).toBeUndefined();
  });

  it("mounts the workspace regardless of the deny-all network mode", async () => {
    const bash = await tool("bash", workspaceCtx({ network: { mode: "deny-all" } }));
    await bash.execute({ command: "pwd" });
    expect(lastSandboxExec().payload.namespace).toBe(NS);
  });

  it("treats persistent Lambda MicroVM sandboxes as background-capable", async () => {
    const { sandboxSupportsBackgroundJobs } = await import("../functions/harness-processing/tools/filesystem-utils.ts");
    expect(sandboxSupportsBackgroundJobs({ provider: "lambda", persistent: true } as never)).toBe(true);
  });

  it("bash rejects commands using runtimes outside the sandbox allow-list", async () => {
    const bash = await tool("bash", workspaceCtx({ runtimes: ["bash"] }));
    const result = await bash.execute({ command: "node script.js" });
    expect(result).toEqual({ type: "error-text", value: "Error: this sandbox does not allow node commands" });
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  it("bash rejects obvious attempts to leave the workspace", async () => {
    const bash = await tool("bash", workspaceCtx());
    await expect(bash.execute({ command: "cd .. && ls" }))
      .resolves.toEqual({ type: "error-text", value: "Error: bash commands must stay in the workspace directory" });
    await expect(bash.execute({ command: "cat /etc/passwd" }))
      .resolves.toEqual({ type: "error-text", value: "Error: absolute paths are not allowed in workspace bash commands: /etc/passwd" });
    await expect(bash.execute({ command: "find / -maxdepth 1" }))
      .resolves.toEqual({ type: "error-text", value: "Error: bash commands must stay in the workspace directory" });
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  it("bash allows URL scheme separators while still blocking absolute paths", async () => {
    const bash = await tool("bash", workspaceCtx());
    const ok = await bash.execute({ command: "curl -sS https://api.github.com/zen -o out.txt" });
    expect(ok.type).toBe("text");
    expect(lastSandboxExec().payload.code).toContain("https://api.github.com/zen");
    // A bare absolute path stays rejected; only the scheme `://` is exempt.
    await expect(bash.execute({ command: "curl https://x -o /tmp/out.txt" }))
      .resolves.toEqual({ type: "error-text", value: "Error: absolute paths are not allowed in workspace bash commands: /tmp/out.txt" });
  });

  it("bash allows relative workspace commands and heredoc bodies", async () => {
    const bash = await tool("bash", workspaceCtx());
    const result = await bash.execute({
      command: [
        "cat > script.py <<'PY'",
        "#!/usr/bin/env python3",
        "print('ok')",
        "PY",
        "python3 script.py 2>/dev/null",
      ].join("\n"),
    });
    expect(result.type).toBe("text");
    expect(lastSandboxExec().payload.code).toContain("python3 script.py");
  });

  it("write base64-pipes content, creates parent dirs, and fsyncs for durability", async () => {
    const write = await tool("write", workspaceCtx());
    await write.execute({ file_path: "notes/a.txt", content: "hello" });
    const { payload } = lastSandboxExec();
    expect(payload.namespace).toBe(NS);
    expect(payload.code).toContain("base64 -d");
    expect(payload.code).toContain("mkdir -p");
    // 1A: flush the file so it commits to the S3 Files server before the Lambda freezes.
    expect(payload.code).toContain("sync ");
  });

  it("read builds a numbered-line read", async () => {
    const read = await tool("read", workspaceCtx());
    await read.execute({ file_path: "a.txt" });
    expect(lastSandboxExec().payload.code).toContain("nl -ba");
  });

  it("edit builds a node heredoc replacement that fsyncs the rewrite", async () => {
    const edit = await tool("edit", workspaceCtx());
    await edit.execute({ file_path: "a.txt", old_string: "x", new_string: "y" });
    const { payload } = lastSandboxExec();
    expect(payload.code).toContain("node <<'NODEEOF'");
    expect(payload.code).toContain("const replaceAll = false");
    // 1A: open/write/fsync/close so the rewrite commits before the Lambda freezes.
    expect(payload.code).toContain("fs.fsyncSync");
  });

  it("glob uses node to match files recursively", async () => {
    const glob = await tool("glob", workspaceCtx());
    await glob.execute({ pattern: "**/*.ts" });
    expect(lastSandboxExec().payload.code).toContain("function matches");
    expect(lastSandboxExec().payload.code).toContain("fs.readdirSync");
  });

  it("grep uses ripgrep", async () => {
    const grep = await tool("grep", workspaceCtx());
    await grep.execute({ pattern: "TODO" });
    const { code } = lastSandboxExec().payload;
    expect(code).toContain("rg");
    expect(code).toContain("'TODO'");
  });

  it("rejects unknown named workspaces", async () => {
    const bash = await tool("bash", {
      workspaces: [
        { name: "personal", workspaceId: "ws_a", namespace: "fs-personal", config: { storage: { provider: "s3" } }, sandbox: { provider: "lambda", network: { mode: "allow-all" } } },
        { name: "team", workspaceId: "ws_b", namespace: "fs-team", config: { storage: { provider: "s3" } }, sandbox: { provider: "lambda", network: { mode: "allow-all" } } },
      ],
    } as never);
    const result = await bash.execute({ command: "pwd", workspace: "unknown" });
    expect(result).toEqual({ type: "error-text", value: "unknown workspace unknown" });
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });
});

describe("read-only S3-direct workspace", () => {
  it("read returns numbered lines straight from S3 without invoking the sandbox", async () => {
    readS3TextMock.mockImplementationOnce(async () => "alpha\nbeta\ngamma\n");
    const read = await tool("read", readonlyCtx());
    const result = await read.execute({ file_path: "notes/a.txt" });
    expect(result).toEqual({
      type: "text",
      value: "     1\talpha\n     2\tbeta\n     3\tgamma\n",
    });
    expect(readS3TextMock).toHaveBeenCalledWith("filesystem-bucket", `${NS}/notes/a.txt`);
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  it("read reports a missing file", async () => {
    readS3TextMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error("nope"), { name: "NoSuchKey" });
    });
    const read = await tool("read", readonlyCtx());
    const result = await read.execute({ file_path: "missing.txt" });
    expect(result).toEqual({ type: "error-text", value: "Error: file not found: missing.txt" });
  });

  it("glob lists matching files from S3 sorted by mtime, newest first", async () => {
    listS3PrefixMock.mockImplementationOnce(async () => [
      { key: `${NS}/old.ts`, lastModified: "2024-01-01T00:00:00.000Z" },
      { key: `${NS}/src/new.ts`, lastModified: "2024-06-01T00:00:00.000Z" },
      { key: `${NS}/skip.md`, lastModified: "2024-07-01T00:00:00.000Z" },
      { key: `${NS}/dir/`, lastModified: "2024-07-01T00:00:00.000Z" },
    ]);
    const glob = await tool("glob", readonlyCtx());
    const result = await glob.execute({ pattern: "**/*.ts" });
    expect(result).toEqual({ type: "text", value: "src/new.ts\nold.ts\n" });
    expect(listS3PrefixMock).toHaveBeenCalledWith("filesystem-bucket", `${NS}/`);
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  it("does not expose write/edit on a read-only workspace (errors if forced)", async () => {
    const write = await tool("write", readonlyCtx());
    const result = await write.execute({ file_path: "a.txt", content: "x" });
    expect(result).toEqual({ type: "error-text", value: "Error: workspace is read-only" });
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });
});

describe("read-only mount workspace (default)", () => {
  it("read routes through the no-internet mounted function, not S3", async () => {
    const read = await tool("read", readonlyMountCtx());
    await read.execute({ file_path: "notes/a.txt" });
    expect(lastSandboxExec()).toMatchObject({
      payload: { namespace: NS, workspace_root: "/mnt/workspaces" },
    });
    expect(lastSandboxExec().payload.code).toContain("nl -ba");
    expect(readS3TextMock).not.toHaveBeenCalled();
  });

  it("glob routes through the no-internet mounted function, not S3", async () => {
    const glob = await tool("glob", readonlyMountCtx());
    await glob.execute({ pattern: "**/*.ts" });
    expect(lastSandboxExec().payload.namespace).toBe(NS);
    expect(lastSandboxExec().payload.code).toContain("function matches");
    expect(listS3PrefixMock).not.toHaveBeenCalled();
  });

  it("still does not expose write/edit (the mount is read-only)", async () => {
    const write = await tool("write", readonlyMountCtx());
    const result = await write.execute({ file_path: "a.txt", content: "x" });
    expect(result).toEqual({ type: "error-text", value: "Error: workspace is read-only" });
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });
});

describe("write/edit approval policy", () => {
  // Returns the raw tool entry so the per-call `needsApproval` predicate is visible.
  async function approval(name: "write" | "edit" | "bash", ctx: never) {
    const mod = await import(`../functions/harness-processing/tools/${name}.tool.ts`);
    return mod.default(ctx)[name] as { needsApproval(input: Record<string, unknown>): boolean };
  }

  it("a read-only workspace never prompts — it falls through to the clean error", async () => {
    // No sandbox => nothing to approve. Without this, permissionMode defaults to
    // "ask" and the write would prompt for an approval it can never satisfy.
    const write = await approval("write", readonlyCtx());
    expect(write.needsApproval({ file_path: "a.txt", content: "x" })).toBe(false);
    const bash = await approval("bash", readonlyCtx());
    expect(bash.needsApproval({ command: "ls" })).toBe(false);
  });

  it("a sandbox-backed workspace follows its permissionMode", async () => {
    const ask = await approval("edit", workspaceCtx({ permissionMode: "ask" }));
    expect(ask.needsApproval({ file_path: "a.txt" })).toBe(true);
    const bypass = await approval("edit", workspaceCtx({ permissionMode: "bypass" }));
    expect(bypass.needsApproval({ file_path: "a.txt" })).toBe(false);
  });
});

describe("toWorkspaceRelative", () => {
  it("normalizes leading slashes and dots to workspace-relative paths", async () => {
    const { toWorkspaceRelative } = await import("../functions/harness-processing/tools/filesystem-utils.ts");
    expect(toWorkspaceRelative("/src/index.ts")).toBe("src/index.ts");
    expect(toWorkspaceRelative("./src/./index.ts")).toBe("src/index.ts");
    expect(toWorkspaceRelative("")).toBe(".");
    expect(toWorkspaceRelative("/")).toBe(".");
    expect(toWorkspaceRelative(".")).toBe(".");
  });

  it("rejects directory traversal anywhere in the path", async () => {
    const { toWorkspaceRelative } = await import("../functions/harness-processing/tools/filesystem-utils.ts");
    for (const path of ["../etc/passwd", "a/../../b", "..", "/a/b/..", "a/.."]) {
      expect(() => toWorkspaceRelative(path)).toThrow("directory traversal not allowed");
    }
  });
});
