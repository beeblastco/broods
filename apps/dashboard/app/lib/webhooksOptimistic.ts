/** Optimistic-update helper for the webhooks panel's active/inactive toggle. */
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { OptimisticLocalStore } from "convex/browser";

// Convex reverts this on its own when the mutation fails, so the pill snaps
// back to the server's truth without a rollback path here.
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

    let touched = false;
    const next = value.map((agent) => {
      if (agent.agentConfigId !== args.agentConfigId) return agent;

      return {
        ...agent,
        webhooks: agent.webhooks.map((webhook) => {
          if (webhook.index !== args.index) return webhook;
          touched = true;

          return { ...webhook, enabled: args.enabled };
        }),
      };
    });

    // A listing without this webhook must not be rewritten, or its observers
    // re-render for a change that never touched them.
    if (!touched) continue;

    localStore.setQuery(api.webhooks.listAgentWebhooks, queryArgs, next);
  }
}
