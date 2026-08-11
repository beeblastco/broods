/**
 * Sandbox tool tests.
 * Cover the Claude-Code-style tool set (bash/read/write/edit/glob/grep): the
 * sandbox-backed path compiling to bash on the AWS Lambda MicroVM sandbox, the
 * read-only mount default, and the S3-direct opt-out path.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_RUNTIME_QUERY = runtime.query;
const ORIGINAL_RUNTIME_MUTATE = runtime.mutate;

// The sandbox now runs as an AWS Lambda MicroVM: control-plane calls go through the
// SDK client, and the exec request is an HTTPS POST to the VM endpoint. Echo the
// request code back as stdout so bash returns "shell:<code>".
const microvmSendMock = mock(async (command: { _type?: string }) => {
  switch (command?._type) {
    case "RunMicrovm":
      return {
        microvmId: "microvm-1",
        endpoint: "microvm-1.lambda-microvm.us-east-1.on.aws",
        state: "PENDING",
      };
    case "CreateMicrovmAuthToken":
      return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
    default:
      return {};
  }
});
const microvmFetchResponse = async (_url: string, init: { body: string }) => {
  const payload = JSON.parse(init.body);

  return new Response(
    JSON.stringify({
      ok: true,
      runtime: payload.runtime,
      exit_code: 0,
      timed_out: false,
      duration_ms: 8,
      stdout: `shell:${payload.code}`,
      stderr: "",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
const microvmFetchMock = mock(microvmFetchResponse);
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
  CreateMicrovmShellAuthTokenCommand: microvmCommand(
    "CreateMicrovmShellAuthToken",
  ),
  TerminateMicrovmCommand: microvmCommand("TerminateMicrovm"),
  GetMicrovmCommand: microvmCommand("GetMicrovm"),
  SuspendMicrovmCommand: microvmCommand("SuspendMicrovm"),
  ResumeMicrovmCommand: microvmCommand("ResumeMicrovm"),
}));

// Read-only (S3-direct) path stubs for sandbox-less workspaces.
const readS3TextMock = mock(async (_bucket: string, _key: string) => "");
const listS3PrefixMock = mock(
  async (_bucket: string, _prefix: string) =>
    [] as Array<{ key: string; lastModified?: string }>,
);

mock.module("../src/shared/s3.ts", () => ({
  readS3Text: readS3TextMock,
  listS3Prefix: listS3PrefixMock,
  isMissingS3Error: (error: unknown) =>
    Boolean(
      error &&
        typeof error === "object" &&
        (error as { name?: string }).name === "NoSuchKey",
    ),
  // Full surface so transitive importers keep working (mock.module replaces the module).
  readS3Bytes: mock(async () => new Uint8Array()),
  writeS3Object: mock(async () => 0),
  s3ObjectExists: mock(async () => true),
  deleteS3Object: mock(async () => {}),
  deleteS3Prefix: mock(async () => 0),
  copyS3Object: mock(async () => {}),
  ensureS3DirectoryMarkers: mock(async () => {}),
  getS3ObjectUrl: mock(async () => "https://example.test/signed"),
}));

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  process.env.MICROVM_IMAGE_IDENTIFIER =
    "arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox";
  process.env.MICROVM_EGRESS_NETWORK_CONNECTOR_ARN =
    "arn:aws:lambda:us-east-1:123456789012:network-connector:vpc-egress";
  globalThis.fetch = microvmFetchMock as unknown as typeof fetch;
  // Reserving a sandbox goes through the Convex reservation registry. Answer "no
  // reservation yet, you won the claim" so a persistent run reaches the VM.
  runtime.query = (async () => null) as typeof runtime.query;
  runtime.mutate = (async () => true) as typeof runtime.mutate;
  microvmSendMock.mockClear();
  microvmFetchMock.mockClear();
  readS3TextMock.mockClear();
  listS3PrefixMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  runtime.query = ORIGINAL_RUNTIME_QUERY;
  runtime.mutate = ORIGINAL_RUNTIME_MUTATE;
});

const NS = "fs-0123456789abcdef0123456789abcdef01234567";

// Sandbox-backed workspace context (file tools route through the mount).
function workspaceCtx(sandboxOverrides: Record<string, unknown> = {}) {
  return {
    workspaces: [
      {
        name: "notes",
        workspaceId: "ws_a",
        namespace: NS,
        config: { storage: { provider: "s3" } },
        sandbox: {
          provider: "lambda",
          network: { mode: "allow-all" },
          ...sandboxOverrides,
        },
      },
    ],
  } as never;
}

// Stateless bash context (no workspace): runs ephemerally on the agent sandbox.
function statelessCtx(sandboxOverrides: Record<string, unknown> = {}) {
  return {
    workspaces: [],
    agentSandbox: {
      provider: "lambda",
      network: { mode: "allow-all" },
      ...sandboxOverrides,
    },
    agentSandboxPermissionMode: "ask",
  } as never;
}

// The workspace is mounted in the agent's OWN sandbox — same record, whether the ref
// named it or inherited it. The agent has the run of that machine.
function ownSandboxCtx(sandboxOverrides: Record<string, unknown> = {}) {
  const sandbox = {
    provider: "lambda",
    network: { mode: "allow-all" },
    controlPlane: { sandboxConfigId: "sb_own" },
    ...sandboxOverrides,
  };

  return {
    workspaces: [
      {
        name: "notes",
        workspaceId: "ws_a",
        namespace: NS,
        config: { storage: { provider: "s3" } },
        sandbox: sandbox,
      },
    ],
    agentSandbox: sandbox,
    agentSandboxPermissionMode: "ask",
  } as never;
}

// The workspace borrows a different sandbox as its execution layer; the agent's own
// sandbox stays beside it, mounted by nothing.
function borrowedSandboxCtx(sandboxOverrides: Record<string, unknown> = {}) {
  return {
    workspaces: [
      {
        name: "notes",
        workspaceId: "ws_a",
        namespace: NS,
        config: { storage: { provider: "s3" } },
        sandbox: {
          provider: "lambda",
          network: { mode: "allow-all" },
          controlPlane: { sandboxConfigId: "sb_borrowed" },
          ...sandboxOverrides,
        },
      },
    ],
    agentSandbox: {
      provider: "lambda",
      network: { mode: "allow-all" },
      controlPlane: { sandboxConfigId: "sb_own" },
    },
    agentSandboxPermissionMode: "ask",
  } as never;
}

// Read-only workspace, `sandbox: null` opt-out (no readMount => served directly from S3).
function readonlyCtx() {
  return {
    workspaces: [
      {
        name: "ro",
        workspaceId: "ws_ro",
        namespace: NS,
        config: { storage: { provider: "s3" } },
      },
    ],
  } as never;
}

// Read-only workspace, default behavior: read/glob run through a service-managed
// read-only mount (readMount) so they see committed writes immediately.
function readonlyMountCtx() {
  return {
    workspaces: [
      {
        name: "ro",
        workspaceId: "ws_ro",
        namespace: NS,
        config: { storage: { provider: "s3" } },
        readMount: { provider: "lambda", network: { mode: "deny-all" } },
      },
    ],
  } as never;
}

async function approvalStatus(
  toolName: string,
  input: Record<string, unknown>,
  ctx: {
    workspaces?: unknown[];
    agentSandbox?: unknown;
    agentSandboxPermissionMode?: unknown;
  },
) {
  const { compatibilityApprovalStatus } = await import(
    "../src/harness/policy.ts"
  );

  return compatibilityApprovalStatus(toolName, input, {
    configuredApprovals: new Map(),
    workspaces: (ctx.workspaces ?? []) as never,
    ...(ctx.agentSandbox ? { agentSandbox: ctx.agentSandbox as never } : {}),
    ...(typeof ctx.agentSandboxPermissionMode === "string"
      ? { agentSandboxPermissionMode: ctx.agentSandboxPermissionMode as never }
      : {}),
  });
}

// The compiled bash the tool sent lands in the body of the exec POST to the VM.
function lastSandboxExec() {
  const call = microvmFetchMock.mock.calls.at(-1) as
    | [string, { body: string }]
    | undefined;

  return { payload: JSON.parse(call![1].body) };
}

function sandboxExecPayloads(): Array<Record<string, unknown>> {
  return microvmFetchMock.mock.calls
    .map((call) => JSON.parse((call[1] as { body: string }).body))
    .filter(
      (payload) =>
        typeof payload.code !== "string" ||
        !payload.code.includes("mountpoint -q "),
    );
}

async function tool(
  name: "bash" | "read" | "write" | "edit" | "glob" | "grep",
  ctx: never,
) {
  const mod = await import(`../src/harness/tools/${name}.tool.ts`);

  return mod.default(ctx)[name.replace("-", "_")] as {
    description: string;
    inputSchema: unknown;
    execute(
      input: Record<string, unknown>,
    ): Promise<{ type: string; value: string }>;
  };
}

describe("sandbox tool set", () => {
  it("bash routes to the mounted internet function when a workspace is attached", async () => {
    const bash = await tool("bash", workspaceCtx());
    const result = await bash.execute({ command: "echo hi" });
    expect(result).toEqual({ type: "text", value: "shell:echo hi" });
    expect(lastSandboxExec()).toMatchObject({
      payload: {
        runtime: "bash",
        namespace: NS,
        code: "echo hi",
        workspace_root: "/mnt/workspaces",
      },
    });
  });

  it("bash pty:true attaches the command to a real guest pseudo-terminal", async () => {
    const bash = await tool("bash", workspaceCtx());
    await bash.execute({ command: "echo hi", pty: true });
    expect(lastSandboxExec().payload.code).toBe(
      "script -qec 'echo hi' /dev/null",
    );
  });

  it("runs a stateless MicroVM (no namespace) when no workspace is attached", async () => {
    const bash = await tool("bash", statelessCtx());
    await bash.execute({ command: "echo hi" });
    expect(lastSandboxExec().payload.namespace).toBeUndefined();
  });

  it("bash treats sandbox setup failures as failed tool calls", async () => {
    microvmFetchMock.mockImplementationOnce(microvmFetchResponse);
    microvmFetchMock.mockImplementationOnce(
      async (_url: string, init: { body: string }) => {
        const payload = JSON.parse(init.body);

        return new Response(
          JSON.stringify({
            ok: false,
            runtime: payload.runtime,
            exit_code: null,
            timed_out: false,
            duration_ms: 8,
            stdout: "",
            stderr: "invalid namespace: must match fs-[a-f0-9]{40}",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const bash = await tool("bash", workspaceCtx());

    await expect(bash.execute({ command: "pwd" })).rejects.toThrow(
      "Sandbox setup failed: invalid namespace",
    );
  });

  it("mounts the workspace regardless of the deny-all network mode", async () => {
    const bash = await tool(
      "bash",
      workspaceCtx({ network: { mode: "deny-all" } }),
    );
    await bash.execute({ command: "pwd" });
    expect(lastSandboxExec().payload.namespace).toBe(NS);
  });

  it("treats persistent Lambda MicroVM sandboxes as background-capable", async () => {
    const { sandboxSupportsBackgroundJobs } = await import(
      "../src/harness/tools/filesystem-utils.ts"
    );
    expect(
      sandboxSupportsBackgroundJobs({
        provider: "lambda",
        persistent: true,
      } as never),
    ).toBe(true);
  });

  it("bash rejects commands using runtimes outside the sandbox allow-list", async () => {
    const bash = await tool("bash", workspaceCtx({ runtimes: ["bash"] }));
    const result = await bash.execute({ command: "node script.js" });
    expect(result).toEqual({
      type: "error-text",
      value: "Error: this sandbox does not allow node commands",
    });
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  it("bash rejects parent directory traversal", async () => {
    const bash = await tool("bash", workspaceCtx());
    await expect(bash.execute({ command: "cd .. && ls" })).resolves.toEqual({
      type: "error-text",
      value: "Error: parent directory traversal is not allowed",
    });
    await expect(
      bash.execute({ command: "cat ../secrets.env" }),
    ).resolves.toEqual({
      type: "error-text",
      value: "Error: parent directory traversal is not allowed",
    });
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  // `..` after a separator escapes just as effectively as a leading one, and the
  // redirection case writes outside the mount rather than only reading.
  it("bash rejects traversal embedded mid-path", async () => {
    const bash = await tool("bash", workspaceCtx());
    for (const command of [
      "cat ./../../etc/os-release",
      "echo pwned > sub/../../../srv/out.txt",
      "cd /mnt/workspaces/x/../../ && ls",
      'cd "dir/.."',
      // bash reads this as `../secrets.env`, so the escapes must come off first.
      "cat \\.\\./secrets.env",
    ]) {
      await expect(bash.execute({ command: command })).resolves.toEqual({
        type: "error-text",
        value: "Error: parent directory traversal is not allowed",
      });
    }
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  // Matching `..` after a separator must not swallow the many non-path uses of two
  // dots, or ordinary git and brace-expansion commands start failing.
  it("bash leaves non-path uses of .. alone", async () => {
    const bash = await tool("bash", workspaceCtx());
    for (const command of [
      "echo {1..10}",
      "git diff main..dev",
      "git log HEAD~2...HEAD",
      'echo "loading..."',
    ]) {
      const result = await bash.execute({ command: command });
      expect(result.type).toBe("text");
    }
  });

  // A sandbox is a whole machine and reading it risks nothing, so the guard is about
  // durability only. Blocking reads used to send the model hunting for a way around
  // the check instead of getting on with the task.
  it("bash reads outside the workspace without complaint", async () => {
    const bash = await tool("bash", workspaceCtx());
    for (const command of [
      "cat /etc/os-release",
      "python3 -c \"print(open('/proc/version').read())\"",
      "ls -la /usr/lib",
    ]) {
      const result = await bash.execute({ command: command });
      expect(result.type).toBe("text");
    }
    expect(sandboxExecPayloads()).toHaveLength(3);
  });

  it("bash rejects writes that would be lost, naming a workspace path to use", async () => {
    const bash = await tool("bash", workspaceCtx());
    const result = await bash.execute({
      command: "echo report > /srv/report.txt",
    });
    expect(result.type).toBe("error-text");
    expect(result.value).toContain("/srv/report.txt is outside the workspace");
    expect(result.value).toContain("./report.txt");

    for (const command of [
      "cp result.json /opt/result.json",
      "tee /var/log/run.log",
      "mkdir /data/out",
      "sed -i 's/a/b/' /etc/hosts",
      "dd if=in.bin of=/mnt/other/out.bin",
      // Destinations that arrive as a flag argument rather than a redirection.
      "curl -o /srv/report.json https://x",
      "wget -O /srv/a.bin https://x",
      "tar -xzf a.tgz -C /srv",
      "unzip a.zip -d /srv",
      "git clone https://github.com/a/b /srv/b",
      "echo x >| /srv/f",
      "ln -s target /srv/link",
    ]) {
      const blocked = await bash.execute({ command: command });
      expect(blocked.type).toBe("error-text");
      expect(blocked.value).toContain("outside the workspace");
    }
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  it("bash allows scratch writes to /tmp and keeps URL schemes working", async () => {
    const bash = await tool("bash", workspaceCtx());
    const ok = await bash.execute({
      command: "curl -sS https://api.github.com/zen -o out.txt",
    });
    expect(ok.type).toBe("text");
    expect(lastSandboxExec().payload.code).toContain(
      "https://api.github.com/zen",
    );
    // /tmp is declared scratch: writing there is a deliberate "this is throwaway".
    for (const command of [
      "curl https://x -o /tmp/out.txt",
      "echo hi > /var/tmp/note",
      "python3 script.py 2>/dev/null",
      "tar -xzf a.tgz -C /tmp/work",
      "git clone https://github.com/a/b ./b",
    ]) {
      const scratch = await bash.execute({ command: command });
      expect(scratch.type).toBe("text");
    }
  });

  it("bash lets the agent write anywhere on its own reserved sandbox", async () => {
    const bash = await tool(
      "bash",
      ownSandboxCtx({
        persistent: true,
        controlPlane: { accountId: "acct_1", sandboxConfigId: "sb_own" },
      }),
    );
    const result = await bash.execute({
      command: "echo report > /srv/report.txt",
    });
    expect(result.type).toBe("text");
    // Containment is a separate concern from durability, so `..` stays blocked —
    // including embedded, where relaxing the write guard would otherwise expose it.
    await expect(
      bash.execute({ command: "cat sub/../../../etc/shadow" }),
    ).resolves.toEqual({
      type: "error-text",
      value: "Error: parent directory traversal is not allowed",
    });
    await expect(
      bash.execute({ command: "cat ../secrets.env" }),
    ).resolves.toEqual({
      type: "error-text",
      value: "Error: parent directory traversal is not allowed",
    });
  });

  it("bash still guards an own sandbox that is not reserved", async () => {
    // Nothing outside the mount survives the call, so the write is still a loss.
    const bash = await tool("bash", ownSandboxCtx());
    const result = await bash.execute({
      command: "echo report > /srv/report.txt",
    });
    expect(result.type).toBe("error-text");
    expect(result.value).toContain("outside the workspace");
  });

  it("bash guards a workspace that borrows someone else's sandbox", async () => {
    // The sandbox is the workspace's execution layer, not the agent's machine —
    // reserved or not, the workspace is all the agent gets to keep.
    const bash = await tool("bash", borrowedSandboxCtx());
    const result = await bash.execute({
      command: "echo report > /srv/report.txt",
    });
    expect(result.type).toBe("error-text");
    expect(result.value).toContain("outside the workspace");
  });

  it("bash only promises a reserved standalone sandbox when it can reconnect", async () => {
    // A run with no workspace has no namespace to key a reservation on, so
    // `persistent` alone is not enough — claiming otherwise tells the model its
    // files survive when index.ts is logging that those runs are ephemeral.
    const bare = await tool("bash", borrowedSandboxCtx());
    expect(bare.description).toContain("reaches durable storage");
    expect(bare.description).not.toContain("That sandbox is reserved");

    const ctx = borrowedSandboxCtx() as unknown as {
      agentSandbox: Record<string, unknown>;
    };
    ctx.agentSandbox.persistent = true;
    const unkeyed = await tool("bash", ctx as never);
    expect(unkeyed.description).not.toContain("That sandbox is reserved");

    ctx.agentSandbox.options = { reservationKey: "agent-scratch" };
    const keyed = await tool("bash", ctx as never);
    expect(keyed.description).toContain("That sandbox is reserved");
    expect(keyed.description).toContain("only the workspace outlives it");
  });

  it("bash describes the write guard only where it actually applies", async () => {
    const reserved = {
      persistent: true,
      controlPlane: { accountId: "acct_1", sandboxConfigId: "sb_own" },
    };
    // Own + reserved: the guard steps aside, so promising a rejection would be a
    // lie the model then works around instead of trusting the tool.
    const own = await tool("bash", ownSandboxCtx(reserved));
    expect(own.description).not.toContain(
      "absolute path elsewhere are rejected",
    );
    expect(own.description).toContain(
      "writing outside the workspace directory",
    );

    // Own but ephemeral: nothing outside the mount survives the call.
    const ephemeral = await tool("bash", ownSandboxCtx());
    expect(ephemeral.description).toContain(
      "Writes to an absolute path elsewhere are rejected",
    );

    // Borrowed: the filesystem does survive between calls, and the description has
    // to say so — the durability bullet is about outliving the reservation.
    const borrowed = await tool(
      "bash",
      borrowedSandboxCtx({ persistent: true }),
    );
    expect(borrowed.description).toContain(
      "absolute path elsewhere are rejected",
    );
    expect(borrowed.description).toContain("survive across calls");
  });

  it("bash offers the standalone sandbox flag only when it is unmounted", async () => {
    const borrowed = await tool("bash", borrowedSandboxCtx());
    const schema = borrowed.inputSchema as unknown as {
      jsonSchema: { properties: { sandbox?: unknown } };
    };
    expect(schema.jsonSchema.properties.sandbox).toBeDefined();

    // Asking for it runs with no workspace mounted, so no namespace is sent.
    const result = await borrowed.execute({
      command: "echo hi",
      sandbox: true,
    });
    expect(result.type).toBe("text");
    expect(lastSandboxExec().payload.namespace).toBeUndefined();

    // When a workspace already mounts that sandbox, the workspace is the way in.
    const own = await tool("bash", ownSandboxCtx());
    const ownSchema = own.inputSchema as unknown as {
      jsonSchema: { properties: { sandbox?: unknown } };
    };
    expect(ownSchema.jsonSchema.properties.sandbox).toBeUndefined();
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
    await edit.execute({
      file_path: "a.txt",
      old_string: "x",
      new_string: "y",
    });
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
        {
          name: "personal",
          workspaceId: "ws_a",
          namespace: "fs-personal",
          config: { storage: { provider: "s3" } },
          sandbox: { provider: "lambda", network: { mode: "allow-all" } },
        },
        {
          name: "team",
          workspaceId: "ws_b",
          namespace: "fs-team",
          config: { storage: { provider: "s3" } },
          sandbox: { provider: "lambda", network: { mode: "allow-all" } },
        },
      ],
    } as never);
    const result = await bash.execute({ command: "pwd", workspace: "unknown" });
    expect(result).toEqual({
      type: "error-text",
      value: "unknown workspace unknown",
    });
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
    expect(readS3TextMock).toHaveBeenCalledWith(
      "filesystem-bucket",
      `${NS}/notes/a.txt`,
    );
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  it("read reports a missing file", async () => {
    readS3TextMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error("nope"), { name: "NoSuchKey" });
    });
    const read = await tool("read", readonlyCtx());
    const result = await read.execute({ file_path: "missing.txt" });
    expect(result).toEqual({
      type: "error-text",
      value: "Error: file not found: missing.txt",
    });
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
    expect(listS3PrefixMock).toHaveBeenCalledWith(
      "filesystem-bucket",
      `${NS}/`,
    );
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  it("does not expose write/edit on a read-only workspace (errors if forced)", async () => {
    const write = await tool("write", readonlyCtx());
    const result = await write.execute({ file_path: "a.txt", content: "x" });
    expect(result).toEqual({
      type: "error-text",
      value: "Error: workspace is read-only",
    });
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
    expect(result).toEqual({
      type: "error-text",
      value: "Error: workspace is read-only",
    });
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });
});

describe("write/edit approval policy", () => {
  it("a read-only workspace never prompts — it falls through to the clean error", async () => {
    // No sandbox => nothing to approve. Without this, permissionMode defaults to
    // "ask" and the write would prompt for an approval it can never satisfy.
    await expect(
      approvalStatus(
        "write",
        { file_path: "a.txt", content: "x" },
        readonlyCtx(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      approvalStatus("bash", { command: "ls" }, readonlyCtx()),
    ).resolves.toBeUndefined();
  });

  it("a sandbox-backed workspace follows its permissionMode", async () => {
    await expect(
      approvalStatus(
        "edit",
        { file_path: "a.txt" },
        workspaceCtx({ permissionMode: "ask" }),
      ),
    ).resolves.toBe("user-approval");
    await expect(
      approvalStatus(
        "edit",
        { file_path: "a.txt" },
        workspaceCtx({ permissionMode: "bypass" }),
      ),
    ).resolves.toBeUndefined();
  });

  // A workspace-scoped policy must not authorize a run that never touches that
  // workspace. Policy input has to name the same target execution picked.
  it("policy input drops workspace identity when the run is on the agent sandbox", async () => {
    const { policyInputForTool } = await import("../src/harness/policy.ts");
    const ctx = borrowedSandboxCtx() as unknown as {
      workspaces: never;
      agentSandbox: never;
    };
    const onSandbox = policyInputForTool(
      "bash",
      { command: "ls", sandbox: true },
      ctx.workspaces,
      { agentSandbox: ctx.agentSandbox },
    );
    expect(onSandbox.workspaceId).toBeUndefined();
    expect(onSandbox.workspaceName).toBeUndefined();
    expect(onSandbox.sandboxPermissionMode).toBeUndefined();

    // A real workspace run still reports it, or workspace-scoped rules stop working.
    const onWorkspace = policyInputForTool(
      "bash",
      { command: "ls", workspace: "notes" },
      ctx.workspaces,
      { agentSandbox: ctx.agentSandbox },
    );
    expect(onWorkspace.workspaceName).toBe("notes");

    // The flag only redirects when a standalone sandbox exists; when the workspace
    // already mounts the agent's sandbox, the run IS the workspace.
    const own = ownSandboxCtx() as unknown as {
      workspaces: never;
      agentSandbox: never;
    };
    const mounted = policyInputForTool(
      "bash",
      { command: "ls", sandbox: true },
      own.workspaces,
      { agentSandbox: own.agentSandbox },
    );
    expect(mounted.workspaceName).toBe("notes");
  });

  it("bash refuses a selection that names both a workspace and the sandbox", async () => {
    const bash = await tool("bash", borrowedSandboxCtx());
    const result = await bash.execute({
      command: "echo hi",
      workspace: "notes",
      sandbox: true,
    });
    expect(result.type).toBe("error-text");
    expect(result.value).toContain("not both");
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  it("the standalone sandbox target follows the agent sandbox's own mode", async () => {
    const ctx = borrowedSandboxCtx() as unknown as {
      workspaces: unknown[];
      agentSandbox: unknown;
      agentSandboxPermissionMode: string;
    };
    await expect(
      approvalStatus("bash", { command: "ls", sandbox: true }, ctx),
    ).resolves.toBe("user-approval");
    await expect(
      approvalStatus(
        "bash",
        { command: "ls", sandbox: true },
        {
          ...ctx,
          agentSandboxPermissionMode: "bypass",
        },
      ),
    ).resolves.toBeUndefined();
    // The workspace keeps its own mode; the agent's bypass does not leak into it.
    await expect(
      approvalStatus(
        "bash",
        { command: "ls", workspace: "notes" },
        {
          ...ctx,
          agentSandboxPermissionMode: "bypass",
        },
      ),
    ).resolves.toBe("user-approval");
  });
});

describe("memory tool", () => {
  // Slack conversation: originSessionId must be the channel scope (thread ts dropped).
  const conversationKey = "acct:a1:agent:ag1:slack:T123:C456:1784216136.381309";

  async function memorySave(ctx: Record<string, unknown>) {
    const mod = await import("../src/harness/tools/memory.tool.ts");

    return mod.default({ ...ctx, conversationKey: conversationKey } as never)
      .memory_save as unknown as {
      execute(
        input: Record<string, unknown>,
      ): Promise<{ type: string; value: string }>;
    };
  }

  it("saves an entry into memory/ with frontmatter metadata and indexes it in memory/MEMORY.md", async () => {
    const memory_save = await memorySave(
      workspaceCtx() as unknown as Record<string, unknown>,
    );
    const result = await memory_save.execute({
      title: "Name in this channel",
      description: "The assistant goes by Lily in #private-test-agent.",
      content: "Here I go by Lily.",
      type: "feedback",
    });
    const { payload } = lastSandboxExec();
    expect(payload.namespace).toBe(NS);
    expect(payload.code).toContain("memory/name-in-this-channel.md");
    expect(payload.code).toContain("memory/MEMORY.md");
    // Same durability discipline as write: base64-piped body, fsynced files, and
    // the entry's index line replaced (not skipped), matched by its anchored
    // defining shape so a cross-reference to this slug in another entry's
    // description is never deleted.
    expect(payload.code).toContain("base64 -d");
    expect(payload.code).toContain("grep -v ");
    expect(payload.code).toContain(
      "^- \\[[^]]*](name-in-this-channel\\.md) — ",
    );
    expect(payload.code).toContain("sync ");
    // The workspace is a mountpoint-s3 FUSE mount: O_APPEND and rename() fail
    // with EPERM, so the index must be rebuilt in one `>` write — never `>>`,
    // `mv`, or a temp file.
    expect(payload.code).toContain("printf '%s\\n%s\\n' \"$index_body\"");
    expect(payload.code).not.toContain(">>");
    expect(payload.code).not.toContain("mv ");
    expect(payload.code).not.toContain(".tmp");
    expect(result.type).toBe("text");

    const entryB64 = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(
      payload.code,
    )?.[1];
    const entry = Buffer.from(entryB64 ?? "", "base64").toString("utf8");
    expect(entry).toContain("name: name-in-this-channel");
    expect(entry).toContain(
      'description: "The assistant goes by Lily in #private-test-agent."',
    );
    expect(entry).toContain("node_type: memory");
    expect(entry).toContain("type: feedback");
    expect(entry).toContain("originSessionId: slack:T123:C456");
    expect(entry).toContain("Here I go by Lily.");
  });

  it("errors cleanly on a read-only workspace without invoking the sandbox", async () => {
    const memory_save = await memorySave(
      readonlyMountCtx() as unknown as Record<string, unknown>,
    );
    const result = await memory_save.execute({
      title: "x",
      description: "d",
      content: "y",
    });
    expect(result).toEqual({
      type: "error-text",
      value: "Error: workspace is read-only",
    });
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  it("refuses a workspace whose memory harness is disabled", async () => {
    const ctx = workspaceCtx() as unknown as {
      workspaces: Array<{ config: Record<string, unknown> }>;
    };
    ctx.workspaces[0]!.config = {
      storage: { provider: "s3" },
      harness: { memory: { enabled: false } },
    };
    const memory_save = await memorySave(
      ctx as unknown as Record<string, unknown>,
    );
    const result = await memory_save.execute({
      title: "x",
      description: "d",
      content: "y",
    });
    expect(result).toEqual({
      type: "error-text",
      value: "Error: the memory harness is disabled for workspace notes",
    });
    expect(microvmFetchMock).not.toHaveBeenCalled();
  });

  it("kebab-cases titles into collision-free slugs and rejects blank titles", async () => {
    const { memorySlug } = await import("../src/harness/tools/memory.tool.ts");
    expect(memorySlug("Owner's Slack handle!")).toBe("owner-s-slack-handle");
    // Diacritics fold into readable ASCII instead of dashes.
    expect(memorySlug("Phích prefers tiếng Việt")).toBe(
      "phich-prefers-tieng-viet",
    );
    // Capped or empty slugs get a stable hash suffix so distinct titles never share a file.
    expect(memorySlug("---")).toMatch(/^memory-[0-9a-f]{8}$/);
    expect(memorySlug("---")).toBe(memorySlug("---"));
    const longA = `${"very long shared prefix ".repeat(4)}variant alpha`;
    const longB = `${"very long shared prefix ".repeat(4)}variant beta`;
    expect(memorySlug(longA)).not.toBe(memorySlug(longB));
    expect(memorySlug(longA).length).toBeLessThanOrEqual(69);
    const memory_save = await memorySave(
      workspaceCtx() as unknown as Record<string, unknown>,
    );
    const result = await memory_save.execute({
      title: "   ",
      description: "d",
      content: "y",
    });
    expect(result).toEqual({
      type: "error-text",
      value: "Error: title must not be empty",
    });
  });
});

describe("toWorkspaceRelative", () => {
  it("normalizes leading slashes and dots to workspace-relative paths", async () => {
    const { toWorkspaceRelative } = await import(
      "../src/harness/tools/filesystem-utils.ts"
    );
    expect(toWorkspaceRelative("/src/index.ts")).toBe("src/index.ts");
    expect(toWorkspaceRelative("./src/./index.ts")).toBe("src/index.ts");
    expect(toWorkspaceRelative("")).toBe(".");
    expect(toWorkspaceRelative("/")).toBe(".");
    expect(toWorkspaceRelative(".")).toBe(".");
  });

  it("rejects directory traversal anywhere in the path", async () => {
    const { toWorkspaceRelative } = await import(
      "../src/harness/tools/filesystem-utils.ts"
    );
    for (const path of [
      "../etc/passwd",
      "a/../../b",
      "..",
      "/a/b/..",
      "a/..",
    ]) {
      expect(() => toWorkspaceRelative(path)).toThrow(
        "directory traversal not allowed",
      );
    }
  });
});
