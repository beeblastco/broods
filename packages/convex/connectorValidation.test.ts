/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  validateGithubToken,
  validateMcpServer,
  type FetchLike,
} from "./model/connectorValidation";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("validateGithubToken", () => {
  test("a valid token resolves the real login", async () => {
    const calls: string[] = [];
    const fetchStub: FetchLike = async (url, init) => {
      calls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer ghp_good",
      );

      return jsonResponse(200, { login: "kien-test" });
    };
    const result = await validateGithubToken("ghp_good", fetchStub);
    expect(result.login).toBe("kien-test");
    expect(calls).toEqual(["https://api.github.com/user"]);
  });

  test("a bad token fails with GitHub's own error, at connect time", async () => {
    const fetchStub: FetchLike = async () =>
      jsonResponse(401, { message: "Bad credentials" });
    await expect(validateGithubToken("ghp_bad", fetchStub)).rejects.toThrow(
      "GitHub rejected the token (HTTP 401: Bad credentials)",
    );
  });
});

describe("validateMcpServer", () => {
  test("full handshake returns the server's advertised tool names", async () => {
    const seen: string[] = [];
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      seen.push(body.method ?? "");
      if (body.method === "initialize") {
        return jsonResponse(
          200,
          {
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: { name: "weather-mcp" },
              capabilities: {},
            },
          },
          { "mcp-session-id": "sess-1" },
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      // tools/list — require the session header round-trip.
      expect((init?.headers as Record<string, string>)["mcp-session-id"]).toBe(
        "sess-1",
      );

      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [{ name: "get_forecast" }, { name: "get_alerts" }],
        },
      });
    };
    const result = await validateMcpServer(
      "https://x.example/mcp",
      {},
      fetchStub,
    );
    expect(result.serverName).toBe("weather-mcp");
    expect(result.toolNames).toEqual(["get_forecast", "get_alerts"]);
    expect(seen).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  test("parses SSE-framed responses (streamable HTTP servers may answer this way)", async () => {
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === "initialize") {
        return new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "sse-mcp" } } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      return new Response(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "t1" }] } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const result = await validateMcpServer(
      "https://x.example/mcp",
      {},
      fetchStub,
    );
    expect(result.serverName).toBe("sse-mcp");
    expect(result.toolNames).toEqual(["t1"]);
  });

  test("a failed initialize is a specific connect-time error — never connected", async () => {
    const fetchStub: FetchLike = async () =>
      new Response("nope", { status: 502, statusText: "Bad Gateway" });
    await expect(
      validateMcpServer("https://down.example/mcp", {}, fetchStub),
    ).rejects.toThrow("MCP initialize failed (HTTP 502 Bad Gateway)");
  });
});
