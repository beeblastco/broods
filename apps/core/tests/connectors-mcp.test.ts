/**
 * MCP connector integration test (ticket 19): a real in-process
 * streamable-HTTP MCP server (SDK server half over node:http) is connected
 * through the actual resolution path — initialize → tools/list → tools
 * registered → a call round-trips — and a dead server degrades to absent
 * tools instead of a crashed run. The MCP client must not meet its first
 * real server in production.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  connectorSlug,
  createConnectorTools,
  decryptConnectorSecret,
  type ConnectorRow,
} from "../src/harness/connectors.ts";
import { encryptConfigObject } from "../src/shared/domain/agent-config.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

let httpServer: Server;
let serverUrl = "";
let echoCalls = 0;
let sawAuthHeader = "";

beforeAll(async () => {
  process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET ??= "test-secret";

  httpServer = createServer((req, res) => {
    sawAuthHeader = String(req.headers["x-test-auth"] ?? "");
    // A fresh server+transport per request: the stateless streamable-HTTP
    // pattern from the SDK docs, ideal for a test.
    const mcp = new McpServer({ name: "test-mcp", version: "1.0.0" });
    mcp.registerTool(
      "echo_upper",
      {
        description: "Echo the input, uppercased",
        inputSchema: { text: z.string() },
      },
      async ({ text }) => {
        echoCalls += 1;

        return { content: [{ type: "text", text: text.toUpperCase() }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    void mcp.connect(transport).then(async () => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        void transport.handleRequest(
          req,
          res,
          body ? JSON.parse(body) : undefined,
        );
      });
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  if (typeof address === "object" && address) {
    serverUrl = `http://127.0.0.1:${address.port}/mcp`;
  }
});

afterAll(() => {
  httpServer?.close();
});

function rowFor(url: string, headers?: Record<string, string>): ConnectorRow {
  const encrypted = headers ? encryptConfigObject({ headers: headers }) : null;

  return {
    _id: "conn_test",
    provider: "mcp",
    label: "Test Weather",
    authKind: "mcp",
    url: url,
    ...(encrypted
      ? {
          encryptedSecret: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretTag: encrypted.tag,
        }
      : {}),
    status: "connected",
  };
}

describe("MCP connector resolution", () => {
  it("initialize → tools/list → registered tool → call round-trips", async () => {
    const originalQuery = runtime.query;
    runtime.query = (async (name: string) =>
      name === "listConnectors"
        ? [rowFor(serverUrl, { "x-test-auth": "s3cret" })]
        : []) as typeof runtime.query;
    try {
      const tools = await createConnectorTools("acct_1", {
        allowed: [{ provider: "mcp", connectorId: "conn_test", enabled: true }],
      });
      const name = `mcp_${connectorSlug("Test Weather")}_echo_upper`;
      expect(Object.keys(tools)).toContain(name);

      const registered = tools[name] as unknown as {
        execute: (input: { text: string }) => Promise<string>;
      };
      const result = await registered.execute({ text: "hello" });
      expect(result).toBe("HELLO");
      expect(echoCalls).toBeGreaterThan(0);
      // Per-connector auth headers from the decrypted secret reach the server.
      expect(sawAuthHeader).toBe("s3cret");
    } finally {
      runtime.query = originalQuery;
    }
  });

  it("a disabled ref resolves no tools", async () => {
    const originalQuery = runtime.query;
    runtime.query = (async () => [rowFor(serverUrl)]) as typeof runtime.query;
    try {
      const tools = await createConnectorTools("acct_1", {
        allowed: [
          { provider: "mcp", connectorId: "conn_test", enabled: false },
        ],
      });
      expect(Object.keys(tools)).toHaveLength(0);
    } finally {
      runtime.query = originalQuery;
    }
  });

  it("an unreachable server degrades to absent tools, not a crash", async () => {
    const originalQuery = runtime.query;
    runtime.query = (async () => [
      rowFor("http://127.0.0.1:9/mcp"),
    ]) as typeof runtime.query;
    try {
      const tools = await createConnectorTools("acct_1", {
        allowed: [{ provider: "mcp", connectorId: "conn_test", enabled: true }],
      });
      expect(Object.keys(tools)).toHaveLength(0);
    } finally {
      runtime.query = originalQuery;
    }
  });
});

describe("connector secret round-trip", () => {
  it("decrypts what the config plane encrypted (shared mechanism)", () => {
    const encrypted = encryptConfigObject({ token: "ghp_test123" });
    const secret = decryptConnectorSecret({
      encryptedSecret: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretTag: encrypted.tag,
    });
    expect(secret.token).toBe("ghp_test123");
  });
});
