import { afterEach, describe, expect, test } from "bun:test";
import { setMcpForTests } from "../../../../apps/core/src/harness/mcp/client.ts";
import { handleMcpServiceRpc } from "../../../../apps/core/src/accounts/mcp-service.ts";
import type { AgentRecord } from "../../../../apps/core/src/shared/domain/agents.ts";
import type { McpRecord } from "../../../../apps/core/src/shared/domain/mcp.ts";
import type { SandboxConfigRecord } from "../../../../apps/core/src/shared/domain/sandbox-config.ts";
import type { CoreRequest } from "../../../../apps/core/src/shared/http.ts";
import { agentSandboxReservationKey } from "../../../../apps/core/src/shared/workspaces.ts";
import {
  setStorageForTests,
  type Storage,
} from "../../../../apps/core/src/shared/storage.ts";

type StorageStubs = { [Store in keyof Storage]?: Partial<Storage[Store]> };

const CREATED_AT = "2026-10-07T00:00:00.000Z";
const BASE_ROW: McpRecord = {
  accountId: "acct_test",
  serverId: "mcp_1",
  projectId: "proj_1",
  stageId: "stage_1",
  name: "plain",
  transport: "http",
  url: "http://127.0.0.1:9/mcp",
  status: "active",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};
const MACHINE_ROW: McpRecord = {
  ...BASE_ROW,
  transport: "machine",
  sandbox: "web",
  command: ["obscura", "mcp"],
};

function rpc(body: unknown): Promise<Response> {
  return handleMcpServiceRpc("acct_test", {
    method: "POST",
    path: "/v1/mcp-service/rpc",
    headers: {},
    body: JSON.stringify(body),
  } as CoreRequest);
}

function sandboxRecord(provider: "lambda" | "machine"): SandboxConfigRecord {
  return {
    accountId: "acct_test",
    sandboxId: "sb_web",
    stageId: "stage_1",
    name: "web",
    config:
      provider === "lambda"
        ? { provider: provider, persistent: true, image: "obscura" }
        : { provider: provider },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function useStorage(
  row: McpRecord,
  host: SandboxConfigRecord,
  agents: AgentRecord[],
): void {
  const stubs: StorageStubs = {
    mcp: { getById: async (): Promise<McpRecord> => row },
    sandboxConfigs: {
      list: async (): Promise<SandboxConfigRecord[]> => [host],
      getById: async (): Promise<SandboxConfigRecord> => host,
    },
    agents: { listForStage: async (): Promise<AgentRecord[]> => agents },
    workspaceConfigs: { getById: async (): Promise<null> => null },
  };
  setStorageForTests(stubs as Storage);
}

async function sandboxSeenBy(): Promise<unknown> {
  let seen: unknown = "unset";
  setMcpForTests({
    listTools: async (connection): Promise<[]> => {
      seen = connection.sandbox;

      return [];
    },
  });
  const response = await rpc({ method: "tools/list", serverId: "mcp_1" });
  expect(response.status).toBe(200);

  return seen;
}

afterEach((): void => {
  setMcpForTests(null);
  setStorageForTests(null);
});

describe("handleMcpServiceRpc probe checks", (): void => {
  const rejected: Array<[string, unknown, string]> = [
    ["no probe", undefined, "rpc needs a serverId or a probe object"],
    ["no name", { transport: "http" }, "probe needs a name"],
    [
      "headers that are not strings",
      { name: "p", transport: "http", url: "http://a.test", headers: { a: 1 } },
      "probe headers must be a string record",
    ],
    [
      "http without url",
      { name: "p", transport: "http" },
      "an http probe needs a url",
    ],
    [
      "hosted without bundle",
      { name: "p", transport: "hosted", sha256: "s" },
      "a hosted probe needs bundleStorageKey and sha256",
    ],
    [
      "hosted with a bad flag",
      {
        name: "p",
        transport: "hosted",
        bundleStorageKey: "k",
        sha256: "s",
        workersCompatible: "yes",
      },
      "probe workersCompatible must be a boolean",
    ],
    [
      "another transport",
      { name: "p", transport: "machine" },
      "probe transport must be http or hosted",
    ],
  ];

  test.each(rejected)(
    "answers 400 for %s",
    async (_name: string, probe: unknown, message: string): Promise<void> => {
      const response = await rpc({ method: "tools/list", probe: probe });

      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain(message);
    },
  );
});

describe("handleMcpServiceRpc explorer sandbox", (): void => {
  test("a stored http server runs without a sandbox", async (): Promise<void> => {
    useStorage(BASE_ROW, sandboxRecord("lambda"), []);

    expect(await sandboxSeenBy()).toBeUndefined();
  });

  test("a machine server on a non-lambda sandbox runs without one", async (): Promise<void> => {
    useStorage(MACHINE_ROW, sandboxRecord("machine"), []);

    expect(await sandboxSeenBy()).toBeUndefined();
  });

  test("an agent whose runtime cannot resolve is not a candidate", async (): Promise<void> => {
    const agent: AgentRecord = {
      accountId: "acct_test",
      agentId: "agent_a",
      name: "agent_a",
      config: {
        sandboxes: ["sb_web"],
        workspaces: [{ name: "gone", workspaceId: "ws_gone" }],
        mcp: { mcp_1: {} },
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    useStorage(MACHINE_ROW, sandboxRecord("lambda"), [agent]);

    expect(await sandboxSeenBy()).toMatchObject({
      reservation: {
        reservationKey: agentSandboxReservationKey(
          "acct_test",
          "mcp-explorer",
          "sb_web",
        ),
      },
    });
  });
});
