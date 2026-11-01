import { describe, expect, test } from "bun:test";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { Edge, Node } from "@xyflow/react";
import {
  analyzeCanvasInfra,
  deriveAgentRuntimeRefs,
  deriveSubagentRefs,
  writeChangedRefs,
} from "../app/lib/canvasRuntimeRefs";

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
): Node {
  return {
    id: id,
    type: type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data },
  } as Node;
}

function edge(source: string, target: string, type?: string): Edge {
  return {
    id: `${source}->${target}`,
    source: source,
    target: target,
    ...(type ? { type: type } : {}),
  } as Edge;
}

describe("analyzeCanvasInfra workspace state", () => {
  test("a writable mount edge wins over the readOnly flag (shared-writable)", () => {
    const nodes = [
      node("agent", "agent", { agentConfigId: "cfg" }),
      node("sb", "sandbox"),
      node("ws", "workspace", { readOnly: true }),
    ];
    const edges = [edge("agent", "ws"), edge("ws", "sb")];

    const { workspaceStates } = analyzeCanvasInfra(nodes, edges);

    expect(workspaceStates.ws.kind).toBe("override");
  });

  test("override demo topology: scratch=inherited, secure=override, reference=readonly", () => {
    const nodes = [
      node("agent", "agent", { agentConfigId: "cfg" }),
      node("default-sandbox", "sandbox"),
      node("secure-sandbox", "sandbox"),
      node("scratch", "workspace", { readOnly: false }),
      node("secure", "workspace", { readOnly: false }),
      node("reference", "workspace", { readOnly: true }),
    ];
    const edges = [
      edge("agent", "default-sandbox"),
      edge("agent", "scratch"),
      edge("agent", "secure"),
      edge("secure", "secure-sandbox"),
      edge("agent", "reference"),
    ];

    const { workspaceStates } = analyzeCanvasInfra(nodes, edges);

    expect(workspaceStates.scratch.kind).toBe("inherited");
    expect(workspaceStates.secure.kind).toBe("override");
    expect(workspaceStates.reference).toEqual({ kind: "readonly" });
  });

  test("a workspace inherits the first sandbox in the agent's order", () => {
    const nodes = [
      node("agent", "agent", {
        agentConfigId: "cfg",
        sandboxOrder: ["b", "a"],
      }),
      node("a", "sandbox"),
      node("b", "sandbox"),
      node("ws", "workspace"),
    ];
    const edges = [edge("agent", "a"), edge("agent", "b"), edge("agent", "ws")];

    const { workspaceStates } = analyzeCanvasInfra(nodes, edges);

    expect(workspaceStates.ws).toEqual({
      kind: "inherited",
      sandboxLabels: ["b"],
    });
  });

  test("a workspace two agents share inherits each agent's own default", () => {
    const nodes = [
      node("one", "agent", { agentConfigId: "cfg-one" }),
      node("two", "agent", { agentConfigId: "cfg-two" }),
      node("a", "sandbox"),
      node("b", "sandbox"),
      node("ws", "workspace"),
    ];
    const edges = [
      edge("one", "a"),
      edge("two", "b"),
      edge("one", "ws"),
      edge("two", "ws"),
    ];

    expect(analyzeCanvasInfra(nodes, edges).workspaceStates.ws).toEqual({
      kind: "inherited",
      sandboxLabels: ["a", "b"],
    });
  });
});

describe("deriveAgentRuntimeRefs", () => {
  test("lists the stored order first, then sandboxes wired since", () => {
    const nodes = [
      node("agent", "agent", {
        agentConfigId: "cfg",
        sandboxOrder: ["mac", "gone", "cloud"],
      }),
      node("cloud", "sandbox", { resourceId: "sb_cloud" }),
      node("gone", "sandbox", { resourceId: "sb_gone" }),
      node("mac", "sandbox", { resourceId: "sb_mac" }),
      node("new", "sandbox", { resourceId: "sb_new" }),
    ];
    const edges = [
      edge("agent", "new"),
      edge("agent", "cloud"),
      edge("agent", "mac"),
    ];

    const [refs] = deriveAgentRuntimeRefs(nodes, edges);

    expect(refs.sandboxes).toEqual(["sb_mac", "sb_cloud", "sb_new"]);
  });

  test("a workspace with no mount edge inherits, and says so by naming no sandbox", () => {
    const nodes = [
      node("agent", "agent", { agentConfigId: "cfg" }),
      node("sb", "sandbox", { resourceId: "sb_1" }),
      node("ws", "workspace", { resourceId: "ws_1" }),
    ];
    const edges = [edge("agent", "sb"), edge("agent", "ws")];

    const [refs] = deriveAgentRuntimeRefs(nodes, edges);

    expect(refs.workspaces).toEqual([{ name: "ws", workspaceId: "ws_1" }]);
  });

  test("the readOnly flag derives `sandbox: null`, which reads straight from S3", () => {
    const nodes = [
      node("agent", "agent", { agentConfigId: "cfg" }),
      node("sb", "sandbox", { resourceId: "sb_1" }),
      node("ws", "workspace", { readOnly: true, resourceId: "ws_1" }),
    ];
    const edges = [edge("agent", "sb"), edge("agent", "ws")];

    const [refs] = deriveAgentRuntimeRefs(nodes, edges);

    expect(refs.workspaces).toEqual([
      { name: "ws", sandbox: null, workspaceId: "ws_1" },
    ]);
  });

  test("a mount edge outranks the flag: the mount is what the ref names", () => {
    const nodes = [
      node("agent", "agent", { agentConfigId: "cfg" }),
      node("sb", "sandbox", { resourceId: "sb_1" }),
      node("ws", "workspace", { readOnly: true, resourceId: "ws_1" }),
    ];
    const edges = [
      edge("agent", "sb"),
      edge("agent", "ws"),
      edge("ws", "sb", "mount"),
    ];

    const [refs] = deriveAgentRuntimeRefs(nodes, edges);

    expect(refs.workspaces).toEqual([
      { name: "ws", sandbox: "sb_1", workspaceId: "ws_1" },
    ]);
  });
});

describe("deriveSubagentRefs", () => {
  test("a subagent edge adds the target's config id to the source's callees", () => {
    const nodes = [
      node("parent", "agent", { agentConfigId: "cfg_parent" }),
      node("child", "agent", { agentConfigId: "cfg_child" }),
    ];
    const edges = [edge("parent", "child", "subagent")];

    const refs = deriveSubagentRefs(nodes, edges);
    const parent = refs.find(
      (r) => r.configId === ("cfg_parent" as Id<"agentConfigs">),
    );
    const child = refs.find(
      (r) => r.configId === ("cfg_child" as Id<"agentConfigs">),
    );

    expect(parent?.calleeConfigIds).toEqual([
      "cfg_child" as Id<"agentConfigs">,
    ]);
    expect(child?.calleeConfigIds).toEqual([]);
  });

  test("non-subagent edges are ignored", () => {
    const nodes = [
      node("parent", "agent", { agentConfigId: "cfg_parent" }),
      node("child", "agent", { agentConfigId: "cfg_child" }),
    ];
    const edges = [edge("parent", "child", "default")];

    const refs = deriveSubagentRefs(nodes, edges);
    const parent = refs.find(
      (r) => r.configId === ("cfg_parent" as Id<"agentConfigs">),
    );

    expect(parent?.calleeConfigIds).toEqual([]);
  });
});

function ref(
  configId: string,
  value: string,
): { configId: Id<"agentConfigs">; value: string } {
  return { configId: configId as Id<"agentConfigs">, value: value };
}

const serializeValue = (r: { value: string }): string => r.value;

describe("writeChangedRefs caching", () => {
  test("skips a ref whose serialization is unchanged", async () => {
    const cache = new Map([["cfg", "a"]]);
    const written: string[] = [];

    await writeChangedRefs(
      [ref("cfg", "a")],
      cache,
      serializeValue,
      async (r) => {
        written.push(r.configId);
      },
    );

    expect(written).toEqual([]);
  });

  test("a failed write stays uncached, so the retry writes it again", async () => {
    const cache = new Map<string, string>();
    let attempts = 0;
    const write = async (): Promise<void> => {
      attempts += 1;
      if (attempts === 1) throw new Error("mutation failed");
    };

    expect(
      writeChangedRefs([ref("cfg", "a")], cache, serializeValue, write),
    ).rejects.toThrow("mutation failed");
    expect(cache.has("cfg")).toBe(false);

    await writeChangedRefs([ref("cfg", "a")], cache, serializeValue, write);

    expect(attempts).toBe(2);
    expect(cache.get("cfg")).toBe("a");
  });

  test("a partial failure caches only the refs that landed", async () => {
    const cache = new Map<string, string>();
    const attempts: string[] = [];
    const write = async (r: { configId: string }): Promise<void> => {
      attempts.push(r.configId);
      if (r.configId === "cfg_bad") throw new Error("mutation failed");
    };

    expect(
      writeChangedRefs(
        [ref("cfg_ok", "a"), ref("cfg_bad", "b")],
        cache,
        serializeValue,
        write,
      ),
    ).rejects.toThrow("mutation failed");

    expect(attempts).toEqual(["cfg_ok", "cfg_bad"]);
    expect(cache.get("cfg_ok")).toBe("a");
    expect(cache.has("cfg_bad")).toBe(false);

    await writeChangedRefs(
      [ref("cfg_ok", "a"), ref("cfg_bad", "b")],
      cache,
      serializeValue,
      async (r) => {
        attempts.push(r.configId);
      },
    );

    expect(attempts).toEqual(["cfg_ok", "cfg_bad", "cfg_bad"]);
  });
});

describe("analyzeCanvasInfra agent reachability", () => {
  test("an infra chain is wired when any member touches an agent", () => {
    const nodes = [
      node("agent", "agent", { agentConfigId: "cfg" }),
      node("sb", "sandbox"),
      node("ws", "workspace"),
    ];
    const edges = [edge("agent", "sb"), edge("ws", "sb")];

    const { connectedToAgent } = analyzeCanvasInfra(nodes, edges);

    expect(connectedToAgent.ws).toBe(true);
    expect(connectedToAgent.sb).toBe(true);
    expect(connectedToAgent.agent).toBe(true);
  });

  test("an infra chain with no agent anywhere stays unwired", () => {
    const nodes = [node("sb", "sandbox"), node("ws", "workspace")];

    const { connectedToAgent } = analyzeCanvasInfra(nodes, [edge("ws", "sb")]);

    expect(connectedToAgent.ws).toBe(false);
    expect(connectedToAgent.sb).toBe(false);
  });

  test("non-infra nodes count only a direct agent edge", () => {
    const nodes = [
      node("agent", "agent", { agentConfigId: "cfg" }),
      node("ws", "workspace"),
      node("wired", "mcp"),
      node("indirect", "mcp"),
    ];
    const edges = [
      edge("agent", "ws"),
      edge("agent", "wired"),
      edge("indirect", "ws"),
    ];

    const { connectedToAgent } = analyzeCanvasInfra(nodes, edges);

    expect(connectedToAgent.wired).toBe(true);
    expect(connectedToAgent.indirect).toBe(false);
    expect(connectedToAgent.ws).toBe(true);
  });
});
