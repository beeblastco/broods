// Root bench suite's in-memory Convex; lives here so convex-test and the generated API resolve.

import { convexTest, type TestConvex } from "convex-test";
import type { FunctionReference } from "convex/server";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import schema from "../schema";

export type RuntimeTest = TestConvex<typeof schema>;

export interface RuntimeFunctions {
  runtime: {
    appendConversationEvent: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        events: { cursor: string; event: unknown }[];
      },
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
      {
        conversationKey: string;
        beforeCursor?: string;
        fromSystemPrefix?: string;
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
        runId: string;
        idempotencyKey: string;
        payloadDigest: string;
        events: unknown[];
        delivery: {
          kind: "http";
          publicEventId: string;
          publicConversationKey: string;
        };
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
    saveHarnessSession: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        ownerEventId: string;
        ownerGeneration: number;
        harnessType: "codex";
        sessionId: string;
        resumeState: unknown;
      },
      unknown
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

// require(): the generated API's types would pull every Convex source under the suite's tsconfig.
export const internal: RuntimeFunctions = require("../_generated/api").internal;

export const envCodec: {
  collectEnvPlaceholderNames(value: unknown): Set<string>;
  substituteAccountEnvPlaceholders<T>(
    config: T,
    variables: Record<string, string>,
  ): T;
} = require("../model/agentConfigCodec");

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Dummy values (as in vitest.config.ts): auth.ts constructs AuthKit at import time.
process.env.BROODS_AUTH_PROVIDER ??= "workos";
process.env.WORKOS_CLIENT_ID ??= "client_test";
process.env.WORKOS_API_KEY ??= "sk_test";
process.env.WORKOS_WEBHOOK_SECRET ??= "whsec_test";

// Built from the filesystem, not vitest's import.meta.glob, so it works under Bun.
const modules: Record<string, () => Promise<unknown>> = {};
for (const path of listFunctionModules(PACKAGE_ROOT)) {
  modules[`../${relative(PACKAGE_ROOT, path)}`] = () => import(path);
}

export function createRuntimeTest(): RuntimeTest {
  return convexTest(schema, modules);
}

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
