import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ToolSet } from "ai";
import * as asyncToolResults from "../src/harness/async-tool-result.ts";
import * as planLimits from "../src/harness/plan-limits.ts";
import * as sandboxes from "../src/harness/sandbox/index.ts";
import * as instanceStore from "../src/harness/sandbox/instance-store.ts";
import type {
  SandboxExecutorConfig,
  SandboxRunRequest,
} from "../src/harness/sandbox/types.ts";
import type { Session } from "../src/harness/session.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import { createTools } from "../src/harness/tools/index.ts";
import * as sandboxInstances from "../src/shared/convex/sandbox-instances.ts";
import type {
  SandboxControlPlane,
  SandboxRunMetadata,
} from "../src/shared/sandbox-sizes.ts";
import type {
  ResolvedAgentSandbox,
  ResolvedWorkspace,
  WorkspaceSandboxConfig,
} from "../src/shared/workspaces.ts";

const RUN: SandboxRunMetadata = {
  traceId: "trace_1",
  taskId: "evt_1",
  agentId: "agent_1",
  conversationKey: "acct:acct_1:agent:agent_1:api:chat",
};
const IN_NOTES: SandboxRunMetadata = {
  ...RUN,
  workspaceName: "notes",
  workspaceId: "ws_notes",
};
const PRINCIPAL = {
  accountId: "acct_1",
  agentId: "agent_1",
  runToken: "brt_test",
};

interface Exec {
  kind: "run" | "background";
  sandbox: string | undefined;
  request: SandboxRunRequest;
}

const ORIGINAL_ENV = { ...process.env };
const anthropic = createAnthropic({ apiKey: "test" });
const execs: Exec[] = [];

beforeEach((): void => {
  execs.length = 0;
});

afterEach((): void => {
  mock.restore();
  process.env = { ...ORIGINAL_ENV };
});

function plane(sandboxConfigId: string): SandboxControlPlane {
  return {
    accountId: "acct_1",
    sandboxConfigId: sandboxConfigId,
    name: sandboxConfigId,
    specs: { vcpu: 1, memoryMb: 1024, storageGb: 8 },
  };
}

// The agent's own sandbox mounts the workspace, so browse runs there too.
const own: WorkspaceSandboxConfig = {
  provider: "lambda",
  image: "obscura",
  persistent: true,
  permissionMode: "bypass",
  network: { mode: "allow-all" },
  controlPlane: plane("sb_own"),
};
const notes: ResolvedWorkspace = {
  name: "notes",
  workspaceId: "ws_notes",
  namespace: "fs-notes",
  config: { storage: { provider: "s3" } },
  sandbox: own,
};
const agentSandboxes: ResolvedAgentSandbox[] = [
  { name: "own", sandbox: own },
  {
    name: "extra",
    sandbox: {
      provider: "lambda",
      permissionMode: "bypass",
      network: { mode: "allow-all" },
      controlPlane: plane("sb_extra"),
    },
  },
];

function recordExecs(): void {
  spyOn(sandboxes, "createSandboxExecutor").mockImplementation(
    (config: SandboxExecutorConfig) => ({
      run: async (request) => {
        execs.push({
          kind: "run",
          sandbox: config.controlPlane?.sandboxConfigId,
          request: request,
        });

        return {
          ok: true,
          runtime: "bash",
          exitCode: 0,
          stdout: "ok\n",
          stderr: "",
          durationMs: 1,
          provider: config.provider,
        };
      },
      runBackground: async (request) => {
        execs.push({
          kind: "background",
          sandbox: config.controlPlane?.sandboxConfigId,
          request: request,
        });

        return { jobId: request.jobId ?? "job_1", externalId: "vm_1" };
      },
    }),
  );
  spyOn(asyncToolResults, "createDetachedAsyncToolResult").mockResolvedValue(
    true,
  );
  spyOn(asyncToolResults, "bindAsyncToolResultSandbox").mockResolvedValue(null);
}

async function build(
  context: {
    workspaces: ResolvedWorkspace[];
    sandboxes: ResolvedAgentSandbox[];
  },
  sandboxMetadata: SandboxRunMetadata | undefined,
  agentConfig: AgentConfig = { browser: { enabled: true } },
): Promise<ToolSet> {
  return await createTools(
    {
      ...context,
      accountId: "acct_1",
      conversationKey: RUN.conversationKey!,
      modelProviderName: "anthropic",
      modelProvider: anthropic,
      session: {
        eventId: "evt_1",
        sandboxPrincipal: () => PRINCIPAL,
      } as unknown as Session,
      ...(sandboxMetadata ? { sandboxMetadata: sandboxMetadata } : {}),
    },
    agentConfig,
  );
}

async function call(
  tools: ToolSet,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return await tools[name]!.execute!(input as never, {
    toolCallId: `call_${name}`,
    messages: [],
    context: {},
  });
}

async function callEvery(tools: ToolSet): Promise<void> {
  await call(tools, "bash", { command: "ls" });
  await call(tools, "bash", { command: "ls", sandbox: "extra" });
  await call(tools, "bash", { command: "sleep 30", background: true });
  await call(tools, "read", { file_path: "a.txt" });
  await call(tools, "glob", { pattern: "*.txt" });
  await call(tools, "write", { file_path: "a.txt", content: "hi" });
  await call(tools, "edit", {
    file_path: "a.txt",
    old_string: "hi",
    new_string: "yo",
  });
  await call(tools, "grep", { pattern: "yo" });
  await call(tools, "memory_save", {
    title: "Tone",
    description: "How to answer",
    content: "Short.",
  });
  await call(tools, "browse", { url: "https://example.com/" });
}

describe("sandbox tools and the run's metadata", () => {
  it("every sandbox tool names the run, agent and conversation to the executor, plus the workspace it used", async (): Promise<void> => {
    recordExecs();
    const tools = await build(
      { workspaces: [notes], sandboxes: agentSandboxes },
      RUN,
    );

    await callEvery(tools);

    expect(
      execs.map((exec) => [exec.kind, exec.sandbox, exec.request.metadata]),
    ).toEqual([
      ["run", "sb_own", IN_NOTES],
      ["run", "sb_extra", RUN],
      ["background", "sb_own", IN_NOTES],
      ...Array.from({ length: 7 }, () => ["run", "sb_own", IN_NOTES]),
    ]);
    // Metadata is not identity: only blocking bash and browse carry the run token.
    expect(execs.map((exec) => exec.request.principal !== undefined)).toEqual([
      true,
      true,
      ...Array.from({ length: 7 }, () => false),
      true,
    ]);
  });

  it("a run without metadata runs every tool and hands the executor none", async (): Promise<void> => {
    recordExecs();
    const tools = await build(
      { workspaces: [notes], sandboxes: agentSandboxes },
      undefined,
    );

    await callEvery(tools);

    expect(execs).toHaveLength(10);
    expect(execs.every((exec) => exec.request.metadata === undefined)).toBe(
      true,
    );
    expect(execs[0]?.request.principal).toEqual(PRINCIPAL);
  });

  it("a provider tool standing in for the file tools hands the executor the same metadata", async (): Promise<void> => {
    recordExecs();
    const tools = await build(
      { workspaces: [notes], sandboxes: agentSandboxes },
      RUN,
      {
        tools: {
          str_replace_based_edit_tool: JSON.parse(
            JSON.stringify(anthropic.tools.textEditor_20250728({})),
          ),
        },
      },
    );

    await call(tools, "str_replace_based_edit_tool", {
      command: "insert",
      path: "a.txt",
      insert_line: 0,
      insert_text: "x",
    });
    await call(tools, "str_replace_based_edit_tool", {
      command: "view",
      path: "a.txt",
    });

    expect(execs.map((exec) => exec.request.metadata)).toEqual([
      IN_NOTES,
      IN_NOTES,
    ]);
  });

  it("a reserved worker sandbox's row and meter name the run that used it", async (): Promise<void> => {
    process.env.CLOUDFLARE_WORKER_URL = "https://worker.example.com";
    process.env.CLOUDFLARE_WORKER_API_KEY = "worker-key";
    spyOn(planLimits, "assertSandboxBudget").mockResolvedValue(undefined);
    spyOn(instanceStore, "getSandboxExternalId").mockResolvedValue(null);
    spyOn(instanceStore, "claimSandboxInstance").mockResolvedValue(true);
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (): Promise<Response> =>
          Response.json({
            ok: true,
            exit_code: 0,
            timed_out: false,
            duration_ms: 7,
            stdout: "ok\n",
            stderr: "",
            truncated: false,
          }),
        { preconnect: (): void => {} },
      ),
    );
    const row = Promise.withResolvers<SandboxRunMetadata | undefined>();
    spyOn(sandboxInstances, "upsertSandboxInstance").mockImplementation(
      async (_plane, _provider, _key, _id, metadata): Promise<void> => {
        row.resolve(metadata);
      },
    );
    const sources: unknown[] = [];
    spyOn(planLimits, "recordUsage").mockImplementation(
      (_accountId, _usage, source): void => {
        sources.push(source);
      },
    );
    const worker: ResolvedAgentSandbox = {
      name: "worker",
      sandbox: {
        provider: "worker",
        persistent: true,
        permissionMode: "bypass",
        network: { mode: "deny-all" },
        options: { reservationKey: "acct_1:agent_1:sb_worker" },
        controlPlane: plane("sb_worker"),
      },
    };
    const tools = await build({ workspaces: [], sandboxes: [worker] }, RUN, {});

    await call(tools, "bash", { command: "echo ok" });

    expect(await row.promise).toEqual(RUN);
    expect(sources).toEqual([{ agentId: "agent_1" }]);
  });
});
