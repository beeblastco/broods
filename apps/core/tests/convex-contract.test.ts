/**
 * Compile-time contract of core's Convex calls: each operation takes its own
 * function's args and returns its own result, with no caller-chosen type. The
 * bodies never run, so nothing reaches Convex; `bun run check` fails when a
 * call that should be refused compiles (`@ts-expect-error` then goes unused).
 */

import { expect, it } from "bun:test";
import { adminQuery, internal } from "../src/shared/convex/client.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

it("binds each Convex operation to its own args and result", () => {
  async function contract(): Promise<boolean> {
    const page = await runtime.query("listConversationEvents", {
      conversationKey: "conversation",
    });
    const done: boolean = page.isDone;
    // @ts-expect-error an argument the function does not take
    await runtime.query("listConversationEvents", { notARealArgument: true });
    // @ts-expect-error the caller cannot choose the result type
    await runtime.query<boolean>("listConversationEvents", {
      conversationKey: "conversation",
    });
    // @ts-expect-error a page is not a boolean
    const wrong: boolean = await runtime.query("listConversationEvents", {
      conversationKey: "conversation",
    });
    // @ts-expect-error a mutation is not a query
    await runtime.query("claimEvent", { accountId: "a", eventId: "e" });
    // @ts-expect-error the storage adapter checks args the same way
    await adminQuery(internal.account.accounts.getById, { id: "a" });

    return done && wrong;
  }

  expect(contract).toBeFunction();
});
