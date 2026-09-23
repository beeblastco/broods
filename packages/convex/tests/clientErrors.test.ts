/// <reference types="vite/client" />
/**
 * A caller's own mistake answers 400 or 409 with its reason, wherever the rule
 * that caught it runs: in the HTTP action or inside a mutation behind
 * `ctx.runMutation`. Anything else is a 500 that names no internals.
 */

import { convexTest } from "convex-test";
import { beforeEach, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ApiErrorBody } from "../model/apiError";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ACCOUNT_SECRET = "fp_acct_client-errors";
const AUTH_ID = "auth_owner";

const errorTest = () => convexTest(schema, modules);

type T = ReturnType<typeof errorTest>;

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

test("a malformed hook answers 400", async () => {
  const t = errorTest();
  await seed(t);

  const response = await send(t, "POST", "/v1/hooks", { events: [] });

  expect(response.status).toBe(400);
  expect(await errorOf(response)).toEqual({
    message: "hook.name is required",
    type: "invalid_request_error",
    code: "invalid_request",
  });
});

test("an empty MCP bundle answers 400", async () => {
  const t = errorTest();
  await seed(t);

  const response = await send(
    t,
    "POST",
    "/v1/mcp?project=demo-app&stage=development",
    { name: "tools", bundle: "" },
  );

  expect(response.status).toBe(400);
  expect((await errorOf(response)).message).toMatch(/^bundle must/);
});

test("a cron schedule rule broken inside the mutation answers 400", async () => {
  const t = errorTest();
  const { agentId } = await seed(t);

  const response = await send(t, "POST", "/v1/crons", {
    name: "nightly",
    agentId: agentId,
    input: "hi",
    scheduleExpression: "cron(0 9 * * *)",
  });

  expect(response.status).toBe(400);
  expect((await errorOf(response)).message).toMatch(
    /^cron\(\.\.\.\) must have six fields/,
  );
});

test("a second record for the same channel answers 409", async () => {
  const t = errorTest();
  await seed(t);
  const record = {
    platform: "slack",
    externalId: "C001",
    name: "#support",
    config: { agentBindings: [{ agentId: "agent-1" }] },
  };

  const first = await send(t, "POST", "/v1/channels", record);
  const second = await send(t, "POST", "/v1/channels", record);

  expect(first.status).toBe(201);
  expect(second.status).toBe(409);
  expect(await errorOf(second)).toEqual({
    message: "A channel record already exists for slack:C001",
    type: "conflict_error",
    code: "conflict",
  });
});

test("an unexpected CLI failure answers a generic 500", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "");
  const t = errorTest();
  await seed(t);

  const response = await send(
    t,
    "GET",
    "/v1/account/projects/demo-app/stages/development/env/API_KEY",
  );

  expect(response.status).toBe(500);
  expect(await errorOf(response)).toEqual({
    message: "CLI request failed",
    type: "api_error",
    code: "internal_error",
  });
});

async function errorOf(response: Response): Promise<ApiErrorBody["error"]> {
  const body = (await response.json()) as ApiErrorBody;

  return body.error;
}

/**
 * One org account with an agent, a `demo-app` project and its Development
 * stage holding one environment variable.
 */
async function seed(t: T): Promise<{ agentId: Id<"agents"> }> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: AUTH_ID,
      plan: "free",
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: await sha256Hex(ACCOUNT_SECRET),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });
    await ctx.db.insert("environmentVariables", {
      projectId: projectId,
      stageId: stageId,
      name: "API_KEY",
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
      valueDigest: "digest",
      updatedAt: now,
    });
    const agentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "planner",
      createdAt: now,
      updatedAt: now,
    });

    return { agentId: agentId };
  });
}

async function send(
  t: T,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  return await t.fetch(path, {
    method: method,
    headers: {
      Authorization: `Bearer ${ACCOUNT_SECRET}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
