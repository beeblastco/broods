/**
 * The Convex functions core calls on every turn, run in memory through
 * convex-test: the real function bodies and validators over an in-process
 * table store, no network. What moves these numbers is the function code,
 * which is the part of Convex cost a code change can regress.
 *
 * One deployment for the whole case: convex-test builds its module cache per
 * instance, and that costs more than any function here. Every op uses its own
 * conversation key, so the few hundred rows a case leaves behind stay out of
 * each other's index ranges.
 */

import {
  createRuntimeTest,
  internal,
  seedAccount,
  type RuntimeTest,
} from "../../packages/convex/bench/harness.bench.ts";
import type { BenchCase } from "../runner.ts";

const LEASE_TTL_MS = 60_000;
const STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHECKPOINT_OWNER = "evt_checkpoint_owner";

const USER_TURN = [
  {
    role: "user",
    content:
      "Summarize the last three deployments for the payments service and flag any that rolled back.",
  },
];

export const convexRuntimeCases: readonly BenchCase[] = [
  {
    name: "convex/ingress-accept-take-settle",
    iterations: 10,
    samples: 15,
    // The whole admission cycle one request costs the config plane: accept as
    // owner, settle the turn, then drain the queue the way the handler does
    // before it dispatches the next event.
    run: async (): Promise<unknown> => {
      const { test, accountId, conversationKey } = await freshConversation();
      const eventId = `evt_${sequence++}`;
      const owner = await admit(test, accountId, conversationKey, eventId);
      await test.mutation(internal.runtimeIngress.settle, {
        conversationKey: conversationKey,
        ownerEventId: eventId,
        ownerGeneration: owner.ownerGeneration!,
        status: "completed",
        result: "done",
      });

      const next = await test.mutation(internal.runtimeIngress.takeNext, {
        conversationKey: conversationKey,
        ownerEventId: eventId,
        ownerGeneration: owner.ownerGeneration!,
        leaseTtlMs: LEASE_TTL_MS,
      });

      return [owner.outcome, next];
    },
  },
  {
    name: "convex/session-save-get",
    iterations: 10,
    samples: 15,
    // One owner for every op: a turn pays the fenced write and the read-back,
    // not the admission that made it owner.
    run: async (): Promise<unknown> => {
      checkpointOwner ??= ownedConversation();
      const { test, conversationKey } = await checkpointOwner;
      await test.mutation(internal.runtimeIngress.saveHarnessSession, {
        conversationKey: conversationKey,
        ownerEventId: CHECKPOINT_OWNER,
        ownerGeneration: 1,
        harnessType: "codex",
        sessionId: `sess_${sequence++}`,
        resumeState: {
          type: "resume-session",
          harnessId: "codex",
          specificationVersion: "harness-v1",
          data: { threadId: "thread-1", turns: 4 },
        },
      });

      return await test.query(internal.runtime.getHarnessSession, {
        conversationKey: conversationKey,
      });
    },
  },
  {
    name: "convex/conversation-append-list",
    iterations: 10,
    samples: 15,
    // A turn's worth of history: four events appended, then the read-back the
    // next turn does before it can build the model context.
    run: async (): Promise<unknown> => {
      const { test, conversationKey } = await freshConversation();
      for (let cursor = 1; cursor <= 4; cursor += 1) {
        await test.mutation(internal.runtime.appendConversationEvent, {
          conversationKey: conversationKey,
          events: [
            {
              cursor: String(cursor).padStart(3, "0"),
              event: {
                role: cursor % 2 ? "user" : "assistant",
                content: `turn ${cursor}`,
              },
            },
          ],
        });
      }

      return await test.query(internal.runtime.listConversationEvents, {
        conversationKey: conversationKey,
      });
    },
  },
];

let sequence = 0;
let checkpointOwner: ReturnType<typeof freshConversation> | null = null;
let shared: { test: RuntimeTest; accountId: string } | null = null;

async function freshConversation(): Promise<{
  test: RuntimeTest;
  accountId: string;
  conversationKey: string;
}> {
  if (!shared) {
    const test = createRuntimeTest();
    shared = { test: test, accountId: await seedAccount(test) };
  }

  return {
    test: shared.test,
    accountId: shared.accountId,
    conversationKey: `acct:${shared.accountId}:agent:bench-agent:api:conv_${sequence++}`,
  };
}

/** A conversation the checkpoint case's owner holds for longer than any run. */
async function ownedConversation(): ReturnType<typeof freshConversation> {
  const conversation = await freshConversation();
  await admit(
    conversation.test,
    conversation.accountId,
    conversation.conversationKey,
    CHECKPOINT_OWNER,
    STATUS_TTL_MS,
  );

  return conversation;
}

function admit(
  test: RuntimeTest,
  accountId: string,
  conversationKey: string,
  eventId: string,
  leaseTtlMs = LEASE_TTL_MS,
): Promise<{ outcome: string; ownerGeneration?: number }> {
  return test.mutation(internal.runtimeIngress.accept, {
    accountId: accountId,
    agentId: "bench-agent",
    conversationKey: conversationKey,
    eventId: eventId,
    runId: `run_${eventId}`,
    idempotencyKey: eventId,
    payloadDigest: `digest:${eventId}`,
    events: USER_TURN,
    delivery: { kind: "http" },
    requestedMode: "followup",
    sizeBytes: 128,
    leaseTtlMs: leaseTtlMs,
    envelopeTtlMs: leaseTtlMs,
    statusTtlMs: STATUS_TTL_MS,
    maxQueuedCount: 100,
    maxQueuedBytes: 1024 * 1024,
  });
}
