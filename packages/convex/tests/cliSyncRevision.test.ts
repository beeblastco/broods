/// <reference types="vite/client" />
/**
 * The manifest PUT claims the stage's next revision. A PUT sent with the
 * revision it read is refused once another sync claimed one, before it writes
 * anything; overlapping PUTs must be refused even when they send no revision.
 */

import cronsComponent from "@convex-dev/crons/test";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { CliManifest, GeneratedIds } from "../cli/types";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const preparation = vi.hoisted(
  (): {
    pause: (() => Promise<void>) | undefined;
    failDeployment: boolean;
  } => ({
    pause: undefined,
    failDeployment: false,
  }),
);

vi.mock(
  "../agent/deployments",
  async (importOriginal): Promise<typeof import("../agent/deployments")> => {
    const original =
      await importOriginal<typeof import("../agent/deployments")>();

    return {
      ...original,
      ensureStageDeployment: async (
        ...args: Parameters<typeof original.ensureStageDeployment>
      ): ReturnType<typeof original.ensureStageDeployment> => {
        if (preparation.failDeployment)
          throw new Error("Injected deployment failure");

        return await original.ensureStageDeployment(...args);
      },
    };
  },
);

vi.mock(
  "../model/mcp",
  async (importOriginal): Promise<typeof import("../model/mcp")> => {
    const original = await importOriginal<typeof import("../model/mcp")>();

    return {
      ...original,
      normalizeMcpInput: async (
        ...args: Parameters<typeof original.normalizeMcpInput>
      ): Promise<Awaited<ReturnType<typeof original.normalizeMcpInput>>> => {
        if (preparation.pause) await preparation.pause();

        return await original.normalizeMcpInput(...args);
      },
    };
  },
);

const modules = import.meta.glob("../**/*.ts");

const PROJECT = "revisions";
const SECRET = "bask_secret_revisions";
const STAGE = "development";

type T = TestConvex<typeof schema>;
type RemoteManifest = { manifest: CliManifest; ids: GeneratedIds };

const t = (): T => {
  const tt = convexTest(schema, modules);
  cronsComponent.register(tt);

  return tt;
};

describe("manifest revision", () => {
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    preparation.pause = undefined;
    preparation.failDeployment = false;
  });

  test("a sync returns the revision it claimed, and the GET reads it", async (): Promise<void> => {
    const tt = t();
    await seedAccount(tt);

    await expectRevision(await put(tt, ["triage"], 0), 1);
    await expectRevision(await put(tt, ["triage"], 1), 2);
    await expectRevision(await get(tt), 2);
  });

  test("a stale sync is refused and leaves the other session's agent", async (): Promise<void> => {
    const tt = t();
    await seedAccount(tt);
    await put(tt, ["triage"], 0);

    const stale = await put(tt, ["support"], 0);

    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "manifest_conflict" },
    });
    expect(await agentNames(tt)).toEqual(["triage"]);
  });

  test.each([undefined, 1])(
    "an overlapping sync with revision %s writes nothing",
    async (revision): Promise<void> => {
      const tt = t();
      await seedAccount(tt);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      preparation.pause = async (): Promise<void> => {
        entered.resolve();
        await resume.promise;
      };
      const first = put(tt, ["triage"], 0, true);
      await entered.promise;
      try {
        const second = await put(tt, ["support"], revision);
        expect(second.status).toBe(409);
        expect(await second.json()).toMatchObject({
          error: { code: "manifest_conflict" },
        });
        expect(await agentNames(tt)).toEqual([]);
      } finally {
        resume.resolve();
        await expectRevision(await first, 1);
      }
      await expectRevision(await put(tt, ["support"], 1), 2);
    },
  );

  test("an abandoned claim expires and its cleanup cannot release the next sync", async (): Promise<void> => {
    const tt = t();
    await seedAccount(tt);
    const secretHash = await sha256Hex(SECRET);
    const first = await tt.mutation(internal.cli.sync.ensureScopeBySecretHash, {
      secretHash: secretHash,
      project: PROJECT,
      stage: STAGE,
      revision: 0,
    });
    await tt.run(async (ctx): Promise<void> => {
      const row = await ctx.db.query("stageSyncs").unique();
      await ctx.db.patch(row!._id, { activeUntil: Date.now() });
    });
    const second = await tt.mutation(
      internal.cli.sync.ensureScopeBySecretHash,
      {
        secretHash: secretHash,
        project: PROJECT,
        stage: STAGE,
        revision: 1,
      },
    );
    await tt.mutation(internal.cli.sync.finishManifestSync, {
      stageId: first.stageId,
      revision: first.revision,
    });
    expect((await put(tt, ["support"], 2)).status).toBe(409);
    await tt.mutation(internal.cli.sync.finishManifestSync, {
      stageId: second.stageId,
      revision: second.revision,
    });
    await expectRevision(await put(tt, ["support"], 2), 3);
  });

  test("the TypeScript manifest round trip satisfies the Lean convergence assumption", async (): Promise<void> => {
    const tt = t();
    await seedAccount(tt);
    const manifest: CliManifest = {
      version: 1,
      project: PROJECT,
      stage: STAGE,
      resources: [
        {
          kind: "workspace",
          name: "repo",
          config: { storage: { provider: "s3" } },
        },
        {
          kind: "sandbox",
          name: "runner",
          config: { provider: "lambda", size: "xsmall" },
        },
        { kind: "policy", name: "tools", config: { version: 1, rules: [] } },
        {
          kind: "agent",
          name: "triage",
          config: {
            model: { provider: "custom", modelId: "Qwen3.6-27B" },
            agent: { system: "Triage requests." },
            workspaces: [{ name: "repo", workspaceId: "repo" }],
            sandboxes: ["runner"],
            policies: ["tools"],
          },
        },
        {
          kind: "channelRecord",
          name: "room",
          config: {
            platform: "slack",
            externalId: "CROUNDTRIP",
            agents: ["triage"],
          },
        },
        {
          kind: "cron",
          name: "daily",
          config: {
            name: "daily",
            status: "active",
            agentId: "triage",
            events: [
              { role: "user", content: [{ type: "text", text: "Triage." }] },
            ],
            scheduleExpression: "rate(1 day)",
          },
        },
        {
          kind: "mcp",
          name: "search",
          config: { transport: "http", url: "https://mcp.example.com/mcp" },
        },
      ],
    };
    const send = async (): Promise<Response> =>
      tt.fetch(`/v1/account/projects/${PROJECT}/stages/${STAGE}/manifest`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ manifest: manifest, prune: true }),
      });
    const response = await send();
    expect(response.status, await response.clone().text()).toBe(200);
    const remote: RemoteManifest = await response.json();
    expect(remote.manifest.resources).toEqual(
      expect.arrayContaining(manifest.resources),
    );
    expect(remote.manifest.resources).toHaveLength(manifest.resources.length);
    const repeated = await send();
    expect(repeated.status).toBe(200);
    const again: RemoteManifest = await repeated.json();
    expect(again.ids).toEqual(remote.ids);
    expect(again.manifest).toEqual(remote.manifest);
  });

  test("a validation failure releases the sync for the next request", async (): Promise<void> => {
    const tt = t();
    await seedAccount(tt);
    expect((await put(tt, [""], 0)).status).toBe(400);
    await expectRevision(await put(tt, ["triage"], 1), 2);
  });

  test("a failure after committed writes releases the sync without rolling back those writes", async (): Promise<void> => {
    const tt = t();
    await seedAccount(tt);
    preparation.failDeployment = true;
    expect((await put(tt, ["triage"], 0)).status).toBe(500);
    expect(await agentNames(tt)).toEqual(["triage"]);
    preparation.failDeployment = false;
    await expectRevision(await put(tt, ["support"], 1), 2);
  });

  test("a sync without a revision applies after the previous sync finishes", async (): Promise<void> => {
    const tt = t();
    await seedAccount(tt);
    await put(tt, ["triage"], 0);

    const unconditional = await put(tt, ["triage", "support"], undefined);

    expect(unconditional.status).toBe(200);
    expect(await agentNames(tt)).toEqual(["support", "triage"]);
  });
});

async function agentNames(tt: T): Promise<string[]> {
  return await tt.run(async (ctx) =>
    (await ctx.db.query("agentConfigs").collect())
      .map((row): string => row.name)
      .sort(),
  );
}

async function expectRevision(
  response: Response,
  revision: number,
): Promise<void> {
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ revision: revision });
}

async function get(tt: T): Promise<Response> {
  return await tt.fetch(
    `/v1/account/projects/${PROJECT}/stages/${STAGE}/manifest`,
    { method: "GET", headers: { Authorization: `Bearer ${SECRET}` } },
  );
}

/** PUTs one agent per name, with `revision` when the caller read one. */
async function put(
  tt: T,
  agents: string[],
  revision: number | undefined,
  slow = false,
): Promise<Response> {
  return await tt.fetch(
    `/v1/account/projects/${PROJECT}/stages/${STAGE}/manifest`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        manifest: {
          version: 1,
          project: PROJECT,
          stage: STAGE,
          resources: [
            ...agents.map((name) => ({
              kind: "agent",
              name: name,
              config: {
                model: { provider: "custom", modelId: "Qwen3.6-27B" },
                agent: { system: `You are ${name}.` },
              },
            })),
            ...(slow
              ? [
                  {
                    kind: "mcp",
                    name: "slow",
                    config: {
                      transport: "http",
                      url: "https://mcp.example.com/mcp",
                    },
                  },
                ]
              : []),
          ],
        },
        prune: false,
        ...(revision !== undefined ? { revision: revision } : {}),
      }),
    },
  );
}

async function seedAccount(tt: T): Promise<void> {
  const secretHash = await sha256Hex(SECRET);

  await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    const userId = await ctx.db.insert("users", {
      authId: "auth_owner",
      email: "owner@example.com",
      name: "Owner",
      plan: "free",
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "owner",
      createdAt: now,
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast-dev",
      secretHash: secretHash,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
}
