import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { OptimisticLocalStore } from "convex/browser";

export function applyWebhookEnabledToggle(
  localStore: OptimisticLocalStore,
  args: {
    agentConfigId: Id<"agentConfigs">;
    index: number;
    enabled: boolean;
  },
): void {
  // The panel's query args carry a stage this mutation never sees: patch every listing held.
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

    // Rewriting an untouched listing would re-render its observers for nothing.
    if (!touched) continue;

    localStore.setQuery(api.webhooks.listAgentWebhooks, queryArgs, next);
  }
}
