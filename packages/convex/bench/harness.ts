/**
 * The in-memory Convex the root benchmark suite drives. It lives in this
 * package so `convex-test` and the generated API resolve from here; the suite
 * imports only this file. Nothing in it touches a deployment.
 */

import { convexTest, type TestConvex } from "convex-test";
import type { FunctionReference } from "convex/server";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import schema from "../schema";

export type RuntimeTest = TestConvex<typeof schema>;

/** The runtime functions the suite calls, with the arguments it passes. */
export interface RuntimeFunctions {
  runtime: {
    appendConversationEvent: FunctionReference<
      "mutation",
      "internal",
      { conversationKey: string; cursor: string; event: unknown },
      unknown
    >;
    getHarnessSession: FunctionReference<
      "query",
      "internal",
      { conversationKey: string },
      unknown
    >;
    listConversationEvents: FunctionReference<
      "query",
      "internal",
      { conversationKey: string },
      unknown
    >;
    saveHarnessSession: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        harnessType: "codex";
        sessionId: string;
        resumeState: unknown;
      },
      unknown
    >;
  };
  runtimeIngress: {
    accept: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: string;
        agentId: string;
        conversationKey: string;
        eventId: string;
        idempotencyKey: string;
        payloadDigest: string;
        events: unknown[];
        delivery: { kind: "http" };
        requestedMode: "followup";
        sizeBytes: number;
        leaseTtlMs: number;
        envelopeTtlMs: number;
        statusTtlMs: number;
        maxQueuedCount: number;
        maxQueuedBytes: number;
      },
      { outcome: string; ownerGeneration?: number }
    >;
    settle: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        ownerEventId: string;
        ownerGeneration: number;
        status: "completed";
        result: string;
      },
      unknown
    >;
    takeNext: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        ownerEventId: string;
        ownerGeneration: number;
        leaseTtlMs: number;
      },
      unknown
    >;
  };
}

// The generated API's types reach back into every Convex source through
// `typeof import(...)`, which would put the whole package under the suite's
// stricter tsconfig. Core reaches it with `require()` for the same reason; the
// shapes above are the calls the suite makes, and Convex validates them at
// runtime regardless.
export const internal: RuntimeFunctions = require("../_generated/api").internal;

/** The env ref substitution the config plane runs at sync time, same reason. */
export const envCodec: {
  collectEnvPlaceholderNames(value: unknown): Set<string>;
  substituteAccountEnvPlaceholders<T>(
    config: T,
    variables: Record<string, string>,
  ): T;
} = require("../model/agentConfigCodec");

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
