/// <reference types="vite/client" />
/** Agent sandboxes travel by name in a manifest and by id at rest. */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { CanvasEdge, CanvasNode } from "../canvas";
import { rewriteIdsToNames, rewriteResourceRefs } from "../model/cliSync";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const SANDBOX_IDS = {
  "general-sandbox": "sb_general",
  "offline-sandbox": "sb_offline",
};

const SECRET_HASH = "hash-sandbox-refs";

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

/** Seeds the org, account and owner membership a CLI sync writes against. */
async function seedAccount(tt: T): Promise<Id<"accounts">> {
  return await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner@example.com",
      plan: "free" as const,
      createdAt: now,
    });
    const userId = await ctx.db.insert("users", {
      authId: "auth_owner@example.com",
      email: "owner@example.com",
      name: "Owner",
      plan: "free" as const,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "owner" as const,
      createdAt: now,
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast-dev",
      secretHash: SECRET_HASH,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  });
}

function sandboxResource(name: string): {
  kind: "sandbox";
  name: string;
  config: Record<string, unknown>;
} {
  return {
    kind: "sandbox",
    name: name,
    config: { provider: "lambda", size: "xsmall" },
  };
}

describe("cli sync sandbox refs", () => {
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("rewrites sandbox names to ids and back", () => {
    const stored = rewriteResourceRefs(
      { sandboxes: ["general-sandbox", "offline-sandbox"] },
      { workspaces: {}, sandboxes: SANDBOX_IDS, policies: {} },
    );

    expect(stored).toEqual({ sandboxes: ["sb_general", "sb_offline"] });
    expect(
      rewriteIdsToNames(stored, {
        workspaces: {},
        sandboxes: {
          sb_general: "general-sandbox",
          sb_offline: "offline-sandbox",
        },
      }),
    ).toEqual({ sandboxes: ["general-sandbox", "offline-sandbox"] });
  });

  test("draws an edge to every listed sandbox and stamps their order", async () => {
    const tt = t();
    await seedAccount(tt);
    const order = ["zeta-sandbox", "alpha-sandbox", "mid-sandbox"];

    await tt.mutation(internal.cli.sync.syncManifestBySecretHash, {
      secretHash: SECRET_HASH,
      manifest: {
        version: 1 as const,
        project: "sandbox-refs",
        stage: "development",
        resources: [
          ...order.map(sandboxResource),
          {
            kind: "agent",
            name: "ordered-agent",
            config: {
              model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
              agent: { system: "You are a helpful assistant." },
              sandboxes: order,
            },
          },
        ],
      },
    });

    const layout = await tt.run(
      async (ctx) => await ctx.db.query("canvasLayouts").first(),
    );
    const nodes = (layout?.nodes ?? []) as CanvasNode[];
    const edges = (layout?.edges ?? []) as CanvasEdge[];
    const agent = nodes.find((node) => node.type === "agent")!;
    const sandboxNodeIds = order.map(
      (name) => nodes.find((node) => node.data.label === name)!.id,
    );

    expect(agent.data.sandboxOrder).toEqual(sandboxNodeIds);
    expect(
      edges
        .filter((edge) => edge.source === agent.id)
        .map((edge) => edge.target)
        .filter((target) => sandboxNodeIds.includes(target))
        .sort(),
    ).toEqual([...sandboxNodeIds].sort());
  });
});
