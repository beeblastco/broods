/**
 * mcp-service rpc tests (#331 dashboard phase): the service-auth'd verbs the
 * Convex mcpService actions call. Network edge stubbed via setMcpForTests;
 * the full chain runs in the local-stack E2E.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { handleMcpServiceRpc } from "../src/accounts/mcp-service.ts";
import { setMcpForTests } from "../src/harness/mcp/client.ts";
import type { SandboxMcpTarget } from "../src/harness/mcp/sandbox.ts";
import * as instanceStore from "../src/harness/sandbox/instance-store.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import type { AgentRecord } from "../src/shared/domain/agents.ts";
import type { McpRecord } from "../src/shared/domain/mcp.ts";
import type { SandboxConfigRecord } from "../src/shared/domain/sandbox-config.ts";
import type { WorkspaceConfigRecord } from "../src/shared/domain/workspace-config.ts";
import type { CoreRequest } from "../src/shared/http.ts";
import { setStorageForTests, type Storage } from "../src/shared/storage.ts";
import { agentSandboxReservationKey } from "../src/shared/workspaces.ts";

const CREATED_AT = "2026-10-07T00:00:00.000Z";
const WEB_SANDBOX: SandboxConfigRecord = {
  accountId: "acct_test",
  sandboxId: "sb_web",
  stageId: "stage_1",
  name: "web",
  config: { provider: "lambda", persistent: true, image: "obscura" },
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};
const OTHER_STAGE_SANDBOX: SandboxConfigRecord = {
  ...WEB_SANDBOX,
  sandboxId: "sb_other_stage",
  stageId: "stage_2",
  config: { provider: "machine" },
};
const OBSCURA_ROW: McpRecord = {
  accountId: "acct_test",
  serverId: "mcp_1",
  projectId: "proj_1",
  stageId: "stage_1",
  name: "obscura",
  transport: "machine",
  sandbox: "web",
  command: ["obscura", "mcp"],
  status: "active",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};
const CHATS_WORKSPACE: WorkspaceConfigRecord = {
  accountId: "acct_test",
  workspaceId: "ws_chats",
  name: "chats",
  config: { storage: { provider: "s3" }, isolation: "conversation" },
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

/** The stores a test stubs, each with only the methods the code under test calls. */
type StorageStubs = { [Store in keyof Storage]?: Partial<Storage[Store]> };

/** A stage agent and, when it has one, its reservation on the `web` sandbox. */
interface StageAgent {
  agentId: string;
  config: AgentConfig;
  reservation?: { claimedAt: number; expiresAt: number };
}

function rpcRequest(body: unknown): CoreRequest {
  return {
    method: "POST",
    path: "/v1/mcp-service/rpc",
    headers: {},
    body: JSON.stringify(body),
  } as CoreRequest;
}

/**
 * Lists the saved obscura row on the `web` lambda sandbox with the given stage
 * agents, and returns the reservation the explorer reached it on.
 */
async function explorerReservation(
  agents: StageAgent[],
): Promise<SandboxMcpTarget["reservation"]> {
  const stubs: StorageStubs = {
    agents: {
      listForStage: async (): Promise<AgentRecord[]> =>
        agents.map((agent): AgentRecord => ({
          accountId: "acct_test",
          agentId: agent.agentId,
          name: agent.agentId,
          config: agent.config,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        })),
    },
    mcp: { getById: async (): Promise<McpRecord> => OBSCURA_ROW },
    sandboxConfigs: {
      list: async (): Promise<SandboxConfigRecord[]> => [
        OTHER_STAGE_SANDBOX,
        WEB_SANDBOX,
      ],
      getById: async (
        _accountId: string,
        sandboxId: string,
      ): Promise<SandboxConfigRecord | null> =>
        sandboxId === "sb_web" ? WEB_SANDBOX : null,
    },
    workspaceConfigs: {
      getById: async (): Promise<WorkspaceConfigRecord> => CHATS_WORKSPACE,
    },
  };
  setStorageForTests(stubs as Storage);
  spyOn(instanceStore, "getSandboxReservationRecord").mockImplementation(
    async (_provider, reservationKey) => {
      const owner = agents.find(
        (agent): boolean =>
          reservationKey ===
          agentSandboxReservationKey("acct_test", agent.agentId, "sb_web"),
      );

      return owner?.reservation
        ? { externalId: `vm_${owner.agentId}`, ...owner.reservation }
        : null;
    },
  );
  const reached: SandboxMcpTarget[] = [];
  setMcpForTests({
    listTools: async function (connection) {
      expect(connection.sandbox).toEqual({
        config: expect.objectContaining({
          provider: "lambda",
          image: "obscura",
        }),
        reservation: expect.anything(),
        command: ["obscura", "mcp"],
      });
      if (connection.sandbox) reached.push(connection.sandbox);

      return [{ name: "fetch", inputSchema: { type: "object" } }];
    },
  });

  const response = await handleMcpServiceRpc(
    "acct_test",
    rpcRequest({ method: "tools/list", serverId: "mcp_1" }),
  );
  expect(response.status).toBe(200);
  expect(reached).toHaveLength(1);

  return reached[0]!.reservation;
}

/** The reservation an agent's own run reserves on the `web` sandbox. */
function agentReservation(agentId: string): { reservationKey: string } {
  return {
    reservationKey: agentSandboxReservationKey("acct_test", agentId, "sb_web"),
  };
}

/** A reservation claimed at `claimedAt`, live unless `expired`. */
function claimed(
  claimedAt: number,
  expired = false,
): { claimedAt: number; expiresAt: number } {
  return {
    claimedAt: claimedAt,
    expiresAt: Date.now() + (expired ? -60_000 : 60_000),
  };
}

describe("mcp-service rpc", () => {
  afterEach(() => {
    setMcpForTests(null);
    setStorageForTests(null);
    mock.restore();
  });

  it("lists tools for a probe without a stored row", async () => {
    setMcpForTests({
      listTools: async function (connection) {
        expect(connection.record.name).toBe("draft");
        expect(connection.record.transport).toBe("http");
        expect(connection.uncached).toBe(true);

        return [{ name: "query", inputSchema: { type: "object" } }];
      },
    });

    const response = await handleMcpServiceRpc(
      "acct_test",
      rpcRequest({
        method: "tools/list",
        probe: {
          name: "draft",
          transport: "http",
          url: "http://127.0.0.1:9/mcp",
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tools: Array<{ name: string }> };
    expect(body.tools.map((tool) => tool.name)).toEqual(["query"]);
  });

  it("prefers the live VM of an agent that uses the server over a newer one", async () => {
    const reservation = await explorerReservation([
      {
        agentId: "agent_a",
        config: { sandboxes: ["sb_web"], mcp: { mcp_1: {} } },
        reservation: claimed(100),
      },
      {
        agentId: "agent_b",
        config: { sandboxes: ["sb_web"] },
        reservation: claimed(200),
      },
    ]);

    expect(reservation).toEqual(agentReservation("agent_a"));
  });

  it("falls back to the newest other live VM, skipping an idle-expired one", async () => {
    const reservation = await explorerReservation([
      {
        agentId: "agent_a",
        config: { sandboxes: ["sb_web"], mcp: { mcp_1: {} } },
      },
      {
        agentId: "agent_b",
        config: { sandboxes: ["sb_web"] },
        reservation: claimed(100),
      },
      {
        agentId: "agent_c",
        config: { sandboxes: ["sb_web"] },
        reservation: claimed(200),
      },
      {
        agentId: "agent_d",
        config: { sandboxes: ["sb_web"] },
        reservation: claimed(300, true),
      },
    ]);

    expect(reservation).toEqual(agentReservation("agent_c"));
  });

  it("starts the VM of the agent that uses the server when no agent VM is live", async () => {
    const reservation = await explorerReservation([
      { agentId: "agent_a", config: { sandboxes: ["sb_web"] } },
      {
        agentId: "agent_b",
        config: { sandboxes: ["sb_web"], mcp: { mcp_1: { enabled: false } } },
      },
      {
        agentId: "agent_c",
        config: { sandboxes: ["sb_web"], mcp: { mcp_1: {} } },
      },
      {
        agentId: "agent_d",
        config: { sandboxes: ["sb_web"], mcp: { mcp_1: {} } },
      },
    ]);

    expect(reservation).toEqual(agentReservation("agent_c"));
  });

  it("reserves a VM of its own when no agent of the stage runs on the sandbox", async () => {
    const reservation = await explorerReservation([
      { agentId: "agent_a", config: { mcp: { mcp_1: {} } } },
    ]);

    expect(reservation).toEqual(agentReservation("mcp-explorer"));
  });

  it("skips an agent whose VM is a conversation-isolated workspace's", async () => {
    const reservation = await explorerReservation([
      {
        agentId: "agent_a",
        config: {
          sandboxes: ["sb_web"],
          workspaces: [{ name: "chats", workspaceId: "ws_chats" }],
          mcp: { mcp_1: {} },
        },
      },
    ]);

    expect(reservation).toEqual(agentReservation("mcp-explorer"));
  });

  it("calls a tool and returns the raw result with isError", async () => {
    setMcpForTests({
      callTool: async function (_connection, toolName, args) {
        expect(toolName).toBe("fail_tool");
        expect(args).toEqual({ q: "x" });

        return {
          content: [{ type: "text", text: "boom" }],
          isError: true,
        };
      },
    });

    const response = await handleMcpServiceRpc(
      "acct_test",
      rpcRequest({
        method: "tools/call",
        toolName: "fail_tool",
        args: { q: "x" },
        probe: {
          name: "draft",
          transport: "hosted",
          bundleStorageKey: "account-mcp/a/bundles/x.mjs",
          sha256: "a".repeat(64),
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { isError?: boolean };
      durationMs: number;
    };
    expect(body.result.isError).toBe(true);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects a malformed probe and an unknown method", async () => {
    const badProbe = await handleMcpServiceRpc(
      "acct_test",
      rpcRequest({ method: "tools/list", probe: { name: "x" } }),
    );
    expect(badProbe.status).toBe(400);

    const badMethod = await handleMcpServiceRpc(
      "acct_test",
      rpcRequest({ method: "resources/list", serverId: "k57x" }),
    );
    expect(badMethod.status).toBe(400);
  });
});
