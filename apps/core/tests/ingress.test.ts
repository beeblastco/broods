/** Durable ingress admission payload contract tests. */

import { afterEach, describe, expect, it } from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";
import {
  acceptIngress,
  type IngressCandidate,
} from "../src/harness/ingress.ts";

const originalMutate = runtime.mutate;

afterEach(() => {
  runtime.mutate = originalMutate;
});

function candidate(): IngressCandidate {
  return {
    accountId: "acct_1",
    agentId: "agent_1",
    eventId: "event-1",
    conversationKey: "acct:acct_1:agent:agent_1:api:conversation-1",
    events: [{ role: "user", content: "hello" }],
    requestedMode: "followup",
    idempotencyKey: "event-1",
    delivery: {
      kind: "http",
      publicEventId: "event-1",
      publicConversationKey: "conversation-1",
    },
  };
}

describe("ingress admission payloads", () => {
  it("persists per-request execution context and covers it in the digest", async () => {
    const calls: Array<Record<string, unknown>> = [];
    runtime.mutate = (async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { outcome: "queued" };
    }) as never;

    await acceptIngress({
      ...candidate(),
      agentConfig: { model: { temperature: 0.1 } },
      ephemeralSystem: [{ role: "system", content: "one-turn override" }],
    });
    await acceptIngress({
      ...candidate(),
      agentConfig: { model: { temperature: 0.9 } },
    });
    await acceptIngress(candidate());

    const [first, second, third] = calls;
    expect(first!.agentConfig).toEqual({ model: { temperature: 0.1 } });
    expect(first!.ephemeralSystem).toEqual([
      { role: "system", content: "one-turn override" },
    ]);
    // Different model/system overrides must never collapse into the same
    // idempotent payload identity.
    expect(first!.payloadDigest).not.toBe(second!.payloadDigest);
    expect(second!.payloadDigest).not.toBe(third!.payloadDigest);
    // Queue byte accounting includes the persisted execution context.
    expect(first!.sizeBytes as number).toBeGreaterThan(
      third!.sizeBytes as number,
    );
  });

  it("keeps the digest stable when no overrides are supplied", async () => {
    const calls: Array<Record<string, unknown>> = [];
    runtime.mutate = (async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { outcome: "owner", ownerGeneration: 1 };
    }) as never;

    await acceptIngress(candidate());
    await acceptIngress(candidate());
    expect(calls[0]!.payloadDigest).toBe(calls[1]!.payloadDigest);
  });
});
