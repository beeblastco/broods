/**
 * The in-memory Convex the root benchmark suite drives. It lives in this
 * package so `convex-test` and the generated API resolve from here; the suite
 * imports only this file. Nothing in it touches a deployment.
 */

import { convexTest, type TestConvex } from "convex-test";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import schema from "../schema";

export { internal } from "../_generated/api";

export type RuntimeTest = TestConvex<typeof schema>;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// convex-test loads every module in the deployment, and `auth.ts` constructs
// AuthKit at import time, which validates these. Dummy values, the same ones
// vitest.config.ts sets; nothing here authenticates.
process.env.WORKOS_CLIENT_ID ??= "client_test";
process.env.WORKOS_API_KEY ??= "sk_test";
process.env.WORKOS_WEBHOOK_SECRET ??= "whsec_test";

/**
 * The module map convex-test needs, built with the filesystem instead of
 * vitest's `import.meta.glob` so it works under Bun. Every function module in
 * the package, keyed the way convex-test expects: relative to this file.
 */
const modules: Record<string, () => Promise<unknown>> = {};
for (const path of listFunctionModules(PACKAGE_ROOT)) {
  modules[`../${relative(PACKAGE_ROOT, path)}`] = () => import(path);
}

/** A fresh, empty in-memory deployment. Cheap: modules load on first use. */
export function createRuntimeTest(): RuntimeTest {
  return convexTest(schema, modules);
}

/**
 * Run a function by its wire path ("runtime:saveHarnessSession"), with args
 * and result in the JSON encoding `ConvexHttpClient` speaks. This is what lets
 * a fake `/api/mutation` endpoint hand core's real client to convex-test.
 */
export async function dispatchByPath(
  test: RuntimeTest,
  kind: "query" | "mutation" | "action",
  path: string,
  encodedArgs: unknown,
): Promise<unknown> {
  const args = jsonToConvex(encodedArgs as Value) as Record<string, Value>;
  const reference = makeFunctionReference<typeof kind>(path);
  const result =
    kind === "query"
      ? await test.query(reference, args)
      : kind === "mutation"
        ? await test.mutation(reference, args)
        : await test.action(reference, args);

  return convexToJson(result === undefined ? null : (result as Value));
}

/** One active account, the way every runtime function expects to find one. */
export async function seedAccount(test: RuntimeTest): Promise<string> {
  const now = Date.now();

  return await test.run(
    async (ctx) =>
      await ctx.db.insert("accounts", {
        orgId: `org-${crypto.randomUUID()}`,
        username: `user-${crypto.randomUUID()}`,
        secretHash: crypto.randomUUID(),
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
  );
}

function listFunctionModules(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // `_generated` stays in: convex-test locates the deployment root by it.
        if (
          entry.name === "node_modules" ||
          entry.name === "tests" ||
          entry.name === "bench"
        ) {
          continue;
        }
        walk(path);
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(path);
      }
    }
  };
  walk(root);

  return found;
}
