import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { handler } from "../src/accounts/handler.ts";
import type { CoreRequest } from "../src/shared/http.ts";
import { setStorageForTests } from "../src/shared/storage.ts";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { setMcpForTests } from "../src/harness/mcp/client.ts";
import * as instanceStore from "../src/harness/sandbox/instance-store.ts";
import * as sandboxAuditEvents from "../src/shared/convex/sandbox-audit-events.ts";
import * as sandboxInstances from "../src/shared/convex/sandbox-instances.ts";

const ACCOUNT = {
  accountId: "acct_test",
  username: "company-a",
  secretHash: "hash",
  status: "active",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
};

afterEach(() => {
  delete process.env.ADMIN_ACCOUNT_SECRET;
  delete process.env.SERVICE_AUTH_SECRET;
  mock.restore();
  setMcpForTests(null);
  setStorageForTests(null);
});

describe("account API error status", () => {
  it("answers an outage with a generic 500, not a 400 with its message", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    setStorageForTests({
      accounts: { getById: async () => ACCOUNT },
      sandboxConfigs: {
        getById: async () => ({
          accountId: "acct_test",
          sandboxId: "sbx_1",
          config: { provider: "daytona" },
        }),
      },
    } as never);
    spyOn(sandboxInstances, "sandboxInstanceIsControllable").mockRejectedValue(
      new Error("connect ECONNREFUSED convex.internal:3210"),
    );

    const response = await handler(
      request("/v1/sandboxes/sbx_1/suspend", "Bearer service-secret", {
        reservationKey: "res_1",
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("convex.internal");
  });

  it("answers a missing reservation with 404 and its code", async () => {
    const response = await sandboxAction("snapshot", { provider: "daytona" });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: {
        message: "no reserved daytona sandbox for this reservation",
        code: "not_found",
      },
    });
  });

  it("answers a sandbox config the caller must fix with 400", async () => {
    const response = await sandboxAction("exec", { provider: "custom" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "custom sandbox needs options.endpoint" },
    });
  });

  it("answers a machine that is not connected with 409", async () => {
    const response = await sandboxAction("exec", { provider: "machine" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "conflict" },
    });
  });

  it("answers an MCP probe whose server fails with 400, a hosted one with 500", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    setStorageForTests({ accounts: { getById: async () => ACCOUNT } } as never);
    setMcpForTests({
      listTools: async () => {
        throw new Error("Unable to connect");
      },
    });
    const probe = (transport: "http" | "hosted"): Promise<Response> =>
      handler(
        request("/v1/mcp-service/rpc", "Bearer service-secret", {
          method: "tools/list",
          probe: {
            name: "docs",
            transport: transport,
            url: "https://mcp.example.com",
            bundleStorageKey: "bundle",
            sha256: "abc",
          },
        }),
      );

    const http = await probe("http");
    expect(http.status).toBe(400);
    expect(await http.json()).toMatchObject({
      error: { message: "MCP server docs failed: Unable to connect" },
    });
    expect((await probe("hosted")).status).toBe(500);
  });

  it("answers an MCP probe that times out with 504", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    setStorageForTests({ accounts: { getById: async () => ACCOUNT } } as never);
    setMcpForTests({
      listTools: async () => {
        throw new SdkError(SdkErrorCode.RequestTimeout, "Request timed out");
      },
    });

    const response = await handler(
      request("/v1/mcp-service/rpc", "Bearer service-secret", {
        method: "tools/list",
        probe: {
          name: "docs",
          transport: "http",
          url: "https://mcp.example.com",
        },
      }),
    );

    expect(response.status).toBe(504);
  });

  it("answers a machine MCP server whose daemon is not running with 409", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    setStorageForTests({
      accounts: { getById: async () => ACCOUNT },
      mcp: {
        getById: async () => ({
          accountId: "acct_test",
          name: "files",
          transport: "machine",
          sandbox: "laptop",
          status: "active",
        }),
      },
      sandboxConfigs: { list: async () => [] },
    } as never);

    const response = await handler(
      request("/v1/mcp-service/rpc", "Bearer service-secret", {
        method: "tools/list",
        serverId: "mcp_1",
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "conflict" },
    });
  });

  it("keeps 400 for a request the caller can fix", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    setStorageForTests({ accounts: {} } as never);

    const response = await handler(
      request("/v1/accounts", "Bearer admin-secret", { username: "" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "username must be a non-empty string" },
    });
  });
});

async function sandboxAction(
  action: string,
  config: { provider: string },
): Promise<Response> {
  process.env.SERVICE_AUTH_SECRET = "service-secret";
  setStorageForTests({
    accounts: { getById: async () => ACCOUNT },
    sandboxConfigs: {
      getById: async () => ({
        accountId: "acct_test",
        sandboxId: "sbx_1",
        name: "box",
        config: config,
      }),
    },
  } as never);
  spyOn(sandboxInstances, "sandboxInstanceIsControllable").mockResolvedValue(
    true,
  );
  spyOn(instanceStore, "getSandboxExternalId").mockResolvedValue(null);
  spyOn(sandboxAuditEvents, "recordSandboxAuditEvent").mockResolvedValue();

  return await handler(
    request(`/v1/sandboxes/sbx_1/${action}`, "Bearer service-secret", {
      reservationKey: "res_1",
      code: "echo hi",
      name: "snap",
    }),
  );
}

function request(
  path: string,
  authorization: string,
  body: unknown,
): CoreRequest {
  return {
    method: "POST",
    path: path,
    search: "",
    query: new URLSearchParams(),
    headers: { authorization: authorization, "x-account-id": "acct_test" },
    body: JSON.stringify(body),
    clientIp: "127.0.0.1",
  };
}
