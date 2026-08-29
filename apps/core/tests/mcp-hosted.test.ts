/**
 * Hosted MCP transport tests (#331 phase 2): the fetch adapter serializes one
 * web request into a runner invoke and rebuilds the child's response. The
 * full chain against a real child-runner + createMcpHandler bundle runs in
 * the local-stack E2E, not here — no SDK fixture bundles in the repo.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { McpRecord } from "../src/shared/domain/mcp.ts";
import {
  hostedMcpFetch,
  setHostedMcpInvokeForTests,
} from "../src/harness/mcp/hosted.ts";

function hostedRecord(): McpRecord {
  return {
    accountId: "acct_test",
    serverId: "k57hosted00000000000000000000000",
    projectId: "proj",
    stageId: "stage",
    name: "hosted",
    transport: "hosted",
    bundleStorageKey: "account-mcp/acct_test/bundles/x.mjs",
    sha256: "a".repeat(64),
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("hosted MCP fetch adapter", () => {
  afterEach(() => {
    setHostedMcpInvokeForTests(null);
  });

  it("serializes the request and rebuilds the child's response", async () => {
    let seen: unknown;
    setHostedMcpInvokeForTests(async (record, request) => {
      seen = { serverName: record.name, request: request };

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      };
    });

    const fetchLike = hostedMcpFetch(hostedRecord());
    const response = await fetchLike("http://mcp-hosted.internal/mcp", {
      method: "POST",
      headers: { "mcp-method": "tools/list" },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    expect(seen).toEqual({
      serverName: "hosted",
      request: {
        method: "POST",
        headers: { "mcp-method": "tools/list" },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      },
    });
  });

  it("surfaces an invoke failure as a thrown error", async () => {
    setHostedMcpInvokeForTests(async () => {
      throw new Error("mcp host Lambda failed: boom");
    });

    const fetchLike = hostedMcpFetch(hostedRecord());
    await expect(
      fetchLike("http://mcp-hosted.internal/mcp", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow("mcp host Lambda failed: boom");
  });
});
