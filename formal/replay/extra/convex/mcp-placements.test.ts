import { describe, expect, test } from "bun:test";
import type { Id } from "../../../../packages/convex/_generated/dataModel";
import type { QueryCtx } from "../../../../packages/convex/_generated/server";
import { loadMcpServersByNode } from "../../../../packages/convex/model/mcp";

interface ServerRow {
  nodeId?: string;
  sandbox?: string;
  transport: string;
}

// Stands in for the Convex query chain, which needs a deployment.
function contextWith(rows: ServerRow[]): QueryCtx {
  const query = {
    withIndex: (): { collect: () => Promise<ServerRow[]> } => ({
      collect: (): Promise<ServerRow[]> => Promise.resolve(rows),
    }),
  };

  return { db: { query: () => query } } as unknown as QueryCtx;
}

const stageId = "stage_1" as Id<"stages">;

describe("loadMcpServersByNode", () => {
  test.each([
    { name: "no servers", rows: [], expected: {} },
    {
      name: "a server not placed on a node is left out",
      rows: [{ transport: "http" }],
      expected: {},
    },
    {
      name: "a placed server keeps its sandbox",
      rows: [{ nodeId: "node_1", sandbox: "sbx", transport: "stdio" }],
      expected: { node_1: { sandbox: "sbx", transport: "stdio" } },
    },
    {
      name: "a placed server with no sandbox reads null, and the last row wins",
      rows: [
        { nodeId: "node_1", sandbox: "old", transport: "stdio" },
        { transport: "http" },
        { nodeId: "node_1", transport: "http" },
        { nodeId: "node_2", transport: "hosted" },
      ],
      expected: {
        node_1: { sandbox: null, transport: "http" },
        node_2: { sandbox: null, transport: "hosted" },
      },
    },
  ])("$name", async ({ rows, expected }) => {
    const placements = await loadMcpServersByNode(contextWith(rows), stageId);

    expect(Object.fromEntries(placements)).toEqual(expected);
  });
});
