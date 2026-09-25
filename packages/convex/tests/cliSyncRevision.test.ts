/// <reference types="vite/client" />
/**
 * The manifest PUT claims the stage's next revision. A PUT sent with the
 * revision it read is refused once another sync claimed one, before it writes
 * anything; a PUT without one (`broods deploy`, an older CLI) always syncs.
 */

import cronsComponent from "@convex-dev/crons/test";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const PROJECT = "revisions";
const SECRET = "fp_secret_revisions";
const STAGE = "development";

type T = TestConvex<typeof schema>;

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

  test("a sync without a revision always syncs", async (): Promise<void> => {
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
          resources: agents.map((name) => ({
            kind: "agent",
            name: name,
            config: {
              model: { provider: "custom", modelId: "Qwen3.6-27B" },
              agent: { system: `You are ${name}.` },
            },
          })),
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
