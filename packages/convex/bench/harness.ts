/**
 * The in-memory Convex the root benchmark suite drives. It lives in this
 * package so `convex-test` and the generated API resolve from here; the suite
 * imports only this file. Nothing in it touches a deployment.
 */

import { convexTest, type TestConvex } from "convex-test";
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
