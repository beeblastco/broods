/**
 * mcp-service rpc tests (#331 dashboard phase): the service-auth'd verbs the
 * Convex mcpService actions call. Network edge stubbed via setMcpForTests;
 * the full chain runs in the local-stack E2E.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { handleMcpServiceRpc } from "../src/accounts/mcp-service.ts";
import { setMcpForTests } from "../src/harness/mcp/client.ts";
import type { CoreRequest } from "../src/shared/http.ts";

function rpcRequest(body: unknown): CoreRequest {
  return {
    method: "POST",
    path: "/v1/mcp-service/rpc",
    headers: {},
    body: JSON.stringify(body),
  } as CoreRequest;
}

describe("mcp-service rpc", () => {
  afterEach(() => {
    setMcpForTests(null);
  });

  it("lists tools for a probe without a stored row", async () => {
    setMcpForTests({
      listTools: async function (connection) {
        expect(connection.record.name).toBe("draft");
        expect(connection.record.transport).toBe("http");

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
