/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const conversationKey =
  "acct:test-account:agent:test-agent:api:test-conversation";

describe("runtime persistence", () => {
  test("claims and leases are atomic and owner-safe", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.mutation(internal.runtimePersistence.claimEvent, {
        key: "acct:test-account:event",
        ttlSeconds: 60,
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.runtimePersistence.claimEvent, {
        key: "acct:test-account:event",
        ttlSeconds: 60,
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.runtimePersistence.acquireLease, {
        key: "lease",
        conversationKey,
        ownerEventId: "owner-1",
        ttlSeconds: 60,
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.runtimePersistence.acquireLease, {
        key: "lease",
        conversationKey,
        ownerEventId: "owner-2",
        ttlSeconds: 60,
      }),
    ).toBe(false);
    await t.mutation(internal.runtimePersistence.releaseLease, {
      key: "lease",
      ownerEventId: "owner-2",
    });
    expect(
      await t.mutation(internal.runtimePersistence.acquireLease, {
        key: "lease",
        conversationKey,
        ownerEventId: "owner-2",
        ttlSeconds: 60,
      }),
    ).toBe(false);
    await t.mutation(internal.runtimePersistence.releaseLease, {
      key: "lease",
      ownerEventId: "owner-1",
    });
    expect(
      await t.mutation(internal.runtimePersistence.acquireLease, {
        key: "lease",
        conversationKey,
        ownerEventId: "owner-2",
        ttlSeconds: 60,
      }),
    ).toBe(true);
  });

  test("orders conversation events and atomically drains pending ingress", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runtimePersistence.appendConversationEvent, {
      conversationKey,
      cursor: "002",
      event: { message: "two" },
    });
    await t.mutation(internal.runtimePersistence.appendConversationEvent, {
      conversationKey,
      cursor: "001",
      event: { message: "one" },
    });
    expect(
      await t.query(internal.runtimePersistence.listConversationEvents, {
        conversationKey,
      }),
    ).toEqual([
      { cursor: "001", event: { message: "one" } },
      { cursor: "002", event: { message: "two" } },
    ]);
    await t.mutation(internal.runtimePersistence.enqueueIngress, {
      key: "pending",
      conversationKey,
      events: [{ role: "user", content: "a" }],
      ttlSeconds: 60,
    });
    await t.mutation(internal.runtimePersistence.enqueueIngress, {
      key: "pending",
      conversationKey,
      events: [{ role: "user", content: "b" }],
      ttlSeconds: 60,
    });
    expect(
      await t.mutation(internal.runtimePersistence.takeIngress, {
        key: "pending",
      }),
    ).toHaveLength(2);
    expect(
      await t.mutation(internal.runtimePersistence.takeIngress, {
        key: "pending",
      }),
    ).toEqual([]);
  });

  test("settles async tools once and seals fan-in groups", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.mutation(internal.runtimePersistence.createAsyncToolResult, {
        resultId: "result-1",
        parentEventId: "acct:test-account:parent",
        conversationKey,
        toolName: "bash",
        toolCallId: "call-1",
        input: { command: "true" },
        delivery: { kind: "async" },
        completionToken: "secret",
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.runtimePersistence.createAsyncToolResult, {
        resultId: "result-1",
        parentEventId: "acct:test-account:parent",
        conversationKey,
        toolName: "bash",
        toolCallId: "call-1",
        input: {},
      }),
    ).toBe(false);
    const group = await t.mutation(
      internal.runtimePersistence.sealAsyncToolGroup,
      { parentEventId: "acct:test-account:parent" },
    );
    expect(group).toMatchObject({ resultIds: ["result-1"], sealed: true });
    expect(
      await t.mutation(internal.runtimePersistence.updateAsyncToolResult, {
        resultId: "result-1",
        status: "completed",
        response: { ok: true },
        onlyWhenProcessing: true,
      }),
    ).toMatchObject({ status: "completed" });
    expect(
      await t.mutation(internal.runtimePersistence.updateAsyncToolResult, {
        resultId: "result-1",
        status: "failed",
        error: "late",
        onlyWhenProcessing: true,
      }),
    ).toBeNull();
    expect(
      await t.query(internal.runtimePersistence.getAsyncToolToken, {
        resultId: "result-1",
      }),
    ).toBe("secret");
    expect(
      await t.query(internal.runtimePersistence.getAsyncToolResult, {
        resultId: "result-1",
      }),
    ).not.toHaveProperty("completionToken");
    await t.mutation(internal.runtimePersistence.updateAsyncToolResult, {
      resultId: "result-1",
      status: "completed",
      observed: true,
    });
    expect(
      await t.query(internal.runtimePersistence.getAsyncToolResult, {
        resultId: "result-1",
      }),
    ).toMatchObject({ observed: true, response: { ok: true } });
  });

  test("claims sandbox reservations and honors expected-id deletes", async () => {
    const t = convexTest(schema, modules);
    const args = { provider: "sandbox" as const, reservationKey: "acct:test-account:workspace:one", externalId: "sandbox-1" };
    expect(await t.mutation(internal.runtimePersistence.claimSandboxReservation, args)).toBe(true);
    expect(await t.mutation(internal.runtimePersistence.claimSandboxReservation, args)).toBe(false);
    await t.mutation(internal.runtimePersistence.deleteSandboxReservation, {
      provider: args.provider, reservationKey: args.reservationKey, expectedExternalId: "sandbox-2",
    });
    expect(await t.query(internal.runtimePersistence.getSandboxReservation, {
      provider: args.provider, reservationKey: args.reservationKey,
    })).toBe("sandbox-1");
    await t.mutation(internal.runtimePersistence.deleteSandboxReservation, {
      provider: args.provider, reservationKey: args.reservationKey, expectedExternalId: "sandbox-1",
    });
    expect(await t.query(internal.runtimePersistence.getSandboxReservation, {
      provider: args.provider, reservationKey: args.reservationKey,
    })).toBeNull();
  });
});
