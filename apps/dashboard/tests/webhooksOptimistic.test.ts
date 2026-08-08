import { describe, expect, test } from "bun:test";
import type { OptimisticLocalStore } from "convex/browser";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { applyWebhookEnabledToggle } from "../app/lib/webhooksOptimistic";

type Listing = {
  agentConfigId: Id<"agentConfigs">;
  agentName: string;
  webhooks: Array<{
    index: number;
    enabled: boolean;
    url?: string;
    secret?: string;
    events: string[];
  }>;
};

function webhook(index: number, enabled: boolean) {
  return {
    index: index,
    enabled: enabled,
    url: `https://h/${index}`,
    events: [],
  };
}

/** Minimal OptimisticLocalStore over one cached `listAgentWebhooks` entry. */
function localStore(
  value: Listing[],
  queryArgs: Record<string, unknown> = { env: "e1" },
) {
  const written: Listing[][] = [];
  const store = {
    getAllQueries: () => [{ args: queryArgs, value: value }],
    setQuery: (_fn: unknown, _args: unknown, next: Listing[]) => {
      written.push(next);
    },
  } as unknown as OptimisticLocalStore;

  return { store: store, written: written };
}

const AGENT = "cfg_a" as Id<"agentConfigs">;
const OTHER = "cfg_b" as Id<"agentConfigs">;

describe("applyWebhookEnabledToggle", () => {
  test("flips only the targeted webhook", () => {
    const { store, written } = localStore([
      {
        agentConfigId: AGENT,
        agentName: "a",
        webhooks: [webhook(0, true), webhook(1, true)],
      },
    ]);

    applyWebhookEnabledToggle(store, {
      agentConfigId: AGENT,
      index: 1,
      enabled: false,
    });

    expect(written[0][0].webhooks.map((w) => w.enabled)).toEqual([true, false]);
  });

  test("leaves other agents' webhooks untouched", () => {
    const value: Listing[] = [
      { agentConfigId: AGENT, agentName: "a", webhooks: [webhook(0, true)] },
      { agentConfigId: OTHER, agentName: "b", webhooks: [webhook(0, true)] },
    ];
    const { store, written } = localStore(value);

    applyWebhookEnabledToggle(store, {
      agentConfigId: AGENT,
      index: 0,
      enabled: false,
    });

    expect(written[0][0].webhooks[0].enabled).toBe(false);
    expect(written[0][1].webhooks[0].enabled).toBe(true);
    // The untouched agent keeps its identity, so its row does not re-render.
    expect(written[0][1]).toBe(value[1]);
  });

  test("does not mutate the cached value in place", () => {
    const value: Listing[] = [
      { agentConfigId: AGENT, agentName: "a", webhooks: [webhook(0, true)] },
    ];
    const { store } = localStore(value);

    applyWebhookEnabledToggle(store, {
      agentConfigId: AGENT,
      index: 0,
      enabled: false,
    });

    // Rollback restores this object, so it must still hold the server's truth.
    expect(value[0].webhooks[0].enabled).toBe(true);
  });

  test("skips a listing that has not loaded", () => {
    const written: unknown[] = [];
    const store = {
      getAllQueries: () => [{ args: {}, value: undefined }],
      setQuery: (...call: unknown[]) => written.push(call),
    } as unknown as OptimisticLocalStore;

    applyWebhookEnabledToggle(store, {
      agentConfigId: AGENT,
      index: 0,
      enabled: false,
    });

    expect(written).toEqual([]);
  });
});

// Referenced so a rename of the query function fails this file too.
expect(api.webhooks.listAgentWebhooks).toBeDefined();
