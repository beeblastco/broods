/**
 * mcp-service rpc tests (#331 dashboard phase): the service-auth'd verbs the
 * Convex mcpService actions call. Network edge stubbed via setMcpForTests;
 * the full chain runs in the local-stack E2E.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { handleMcpServiceRpc } from "../src/accounts/mcp-service.ts";
import { setMcpForTests } from "../src/harness/mcp/client.ts";
import * as instanceStore from "../src/harness/sandbox/instance-store.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import type { CoreRequest } from "../src/shared/http.ts";
import { setStorageForTests } from "../src/shared/storage.ts";
import { agentSandboxReservationKey } from "../src/shared/workspaces.ts";

const WEB_SANDBOX = {
  sandboxId: "sb_web",
  stageId: "stage_1",
  name: "web",
  config: { provider: "lambda", persistent: true, image: "obscura" },
};

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
 * agents and live reservation claim times, and returns the reservation the
 * explorer reached it on.
 */
async function explorerReservation(
  agents: Array<{ agentId: string; config: AgentConfig }>,
  claimedAt: Record<string, number> = {},
): Promise<unknown> {
  setStorageForTests({
    agents: {
      listForStage: async () =>
        agents.map((agent) => ({ ...agent, accountId: "acct_test" })),
    },
    mcp: {
      getById: async () => ({
        accountId: "acct_test",
        serverId: "mcp_1",
        projectId: "proj_1",
        stageId: "stage_1",
        name: "obscura",
        transport: "machine",
        sandbox: "web",
        command: ["obscura", "mcp"],
        status: "active",
        createdAt: "2026-10-07T00:00:00.000Z",
        updatedAt: "2026-10-07T00:00:00.000Z",
      }),
    },
    sandboxConfigs: {
      list: async () => [
        {
          sandboxId: "sb_other_stage",
          stageId: "stage_2",
          name: "web",
          config: { provider: "machine" },
        },
        WEB_SANDBOX,
      ],
      getById: async (_accountId: string, sandboxId: string) =>
        sandboxId === "sb_web" ? WEB_SANDBOX : null,
    },
  } as never);
  spyOn(instanceStore, "getSandboxReservationRecord").mockImplementation(
    async (_provider, reservationKey) => {
      const claimed = Object.entries(claimedAt).find(
        ([agentId]) =>
          reservationKey ===
          agentSandboxReservationKey("acct_test", agentId, "sb_web"),
      );

      return claimed ? { externalId: "vm", claimedAt: claimed[1] } : null;
    },
  );
  const reached: Array<{ reservation: unknown }> = [];
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
      reached.push(connection.sandbox!);

      return [{ name: "fetch", inputSchema: { type: "object" } }] as never;
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

        return [{ name: "query", inputSchema: { type: "object" } }] as never;
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

  it("runs a lambda-sandbox row on the VM of the agent whose reservation is live, newest first", async () => {
    const reservation = await explorerReservation(
      [
        {
          agentId: "agent_a",
          config: { sandboxes: ["sb_web"], mcp: { mcp_1: {} } },
        },
        { agentId: "agent_b", config: { sandboxes: ["sb_web"] } },
        { agentId: "agent_c", config: { sandboxes: ["sb_web"] } },
      ],
      { agent_b: 100, agent_c: 200 },
    );

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

  it("calls a tool and returns the raw result with isError", async () => {
    setMcpForTests({
      callTool: async function (_connection, toolName, args) {
        expect(toolName).toBe("fail_tool");
        expect(args).toEqual({ q: "x" });

        return {
          content: [{ type: "text", text: "boom" }],
          isError: true,
        } as never;
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
