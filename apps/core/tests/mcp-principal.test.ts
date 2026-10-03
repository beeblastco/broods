/**
 * Remote MCP requests name the calling agent and its delegation chain, on
 * headers kept apart from the row's own so the listing cache stays shared.
 */

import { describe, expect, it } from "bun:test";
import {
  mcpConnection,
  mcpRequestHeaders,
  MCP_AGENT_ID_HEADER,
  MCP_PRINCIPAL_HEADER,
} from "../src/harness/mcp/client.ts";
import type { McpRecord } from "../src/shared/domain/mcp.ts";
import type { Principal } from "../src/shared/domain/principal.ts";

const MCP_RECORD: McpRecord = {
  accountId: "acct_1",
  serverId: "mcp_1",
  projectId: "proj_1",
  stageId: "stage_1",
  name: "search",
  transport: "http",
  url: "https://mcp.example.com/mcp",
  headers: { "X-Api-Key": "k" },
  status: "active",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

describe("mcp principal headers", () => {
  const principal: Principal = {
    kind: "agent",
    accountId: "acct_1",
    agentId: "agent_1",
    chain: [{ kind: "user", id: "U1", channel: "slack" }],
  };

  it("sends the agent id and the chain on every request, outside the row headers", async () => {
    const connection = mcpConnection(
      MCP_RECORD,
      undefined,
      undefined,
      principal,
    );
    expect(connection.headers).toEqual({ "X-Api-Key": "k" });
    const headers = await mcpRequestHeaders(connection);
    expect(headers[MCP_AGENT_ID_HEADER]).toBe("agent_1");
    expect(
      JSON.parse(
        Buffer.from(headers[MCP_PRINCIPAL_HEADER]!, "base64url").toString(),
      ),
    ).toEqual([
      { kind: "user", id: "U1", channel: "slack" },
      { kind: "agent", agentId: "agent_1" },
    ]);
    expect(headers["X-Api-Key"]).toBe("k");
    expect(
      await mcpRequestHeaders(mcpConnection(MCP_RECORD, undefined)),
    ).toEqual({ "X-Api-Key": "k" });
  });

  it("drops a row or config header that claims either principal name, in any case", async () => {
    const spoofed = {
      "x-broods-agent-id": "agent_admin",
      "X-BROODS-PRINCIPAL": "e30",
    };
    for (const connection of [
      mcpConnection(
        { ...MCP_RECORD, headers: { ...MCP_RECORD.headers, ...spoofed } },
        spoofed,
        undefined,
        principal,
      ),
      mcpConnection(MCP_RECORD, spoofed),
    ]) {
      const wire = new Headers(await mcpRequestHeaders(connection));
      expect(wire.get(MCP_AGENT_ID_HEADER)).toBe(
        connection.principalHeaders ? "agent_1" : null,
      );
      expect(wire.get(MCP_PRINCIPAL_HEADER)).toBe(
        connection.principalHeaders?.[MCP_PRINCIPAL_HEADER] ?? null,
      );
      expect(wire.get("X-Api-Key")).toBe("k");
    }
  });
});
