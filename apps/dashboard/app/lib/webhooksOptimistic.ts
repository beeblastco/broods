/** Optimistic-update helper for the webhooks panel's active/inactive toggle. */
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { OptimisticLocalStore } from "convex/browser";

/**
 * Flips one webhook's `enabled` flag in the cached `listAgentWebhooks` result so
 * the pill switches on click instead of after the round-trip. Convex reverts this
 * on its own if the mutation fails, so the pill snaps back to the server's truth.
 */
export function applyWebhookEnabledToggle(
  localStore: OptimisticLocalStore,
  args: {
    agentConfigId: Id<"agentConfigs">;
    index: number;
    enabled: boolean;
  },
): void {
  // The panel's query args carry the environment, which this mutation never
  // sees — patch whichever listing the panel currently holds.
  for (const { args: queryArgs, value } of localStore.getAllQueries(
    api.webhooks.listAgentWebhooks,
  )) {
    if (!value) continue;

    const next = value.map((agent) =>
      agent.agentConfigId !== args.agentConfigId
        ? agent
        : {
            ...agent,
            webhooks: agent.webhooks.map((webhook) =>
              webhook.index === args.index
                ? { ...webhook, enabled: args.enabled }
                : webhook,
            ),
          },
    );

    localStore.setQuery(api.webhooks.listAgentWebhooks, queryArgs, next);
  }
}
