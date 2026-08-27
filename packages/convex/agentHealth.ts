/**
 * DB half of the one-button health check (ticket 23): ownership-checked,
 * env-resolved view of one agent's nested config for agentHealthPublic.check.
 * The resolved config carries real secrets — it is internal-only and must
 * never be returned to a client; the public action returns plain-language
 * check results.
 */

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { loadAgentRuntimeSecrets } from "./model/agentRuntimeSecrets";
import {
  substituteEnvPlaceholders,
  toNestedAgentConfig,
} from "./model/agentConfigCodec";
import { resolveAgentConversationScope } from "./model/conversationHistory";

export const getHealthContext = internalQuery({
  args: { authId: v.string(), configId: v.id("agentConfigs") },
  returns: v.union(
    v.null(),
    v.object({
      accountId: v.string(),
      projectId: v.id("projects"),
      nested: v.any(),
    }),
  ),
  handler: async (ctx, args) => {
    const scope = await resolveAgentConversationScope(
      ctx,
      args.authId,
      args.configId,
    );
    if (!scope) return null;
    const config = await ctx.db.get(args.configId);
    if (!config) return null;

    const variables = await loadAgentRuntimeSecrets(ctx, args.configId);
    const nested = substituteEnvPlaceholders(
      toNestedAgentConfig({
        name: config.name,
        description: config.description,
        provider: config.provider,
        modelId: config.modelId,
        systemPrompt: config.systemPrompt,
        maxTurns: config.maxTurns,
        outputFormat: config.outputFormat as
          Record<string, unknown> | undefined,
        providerOptions: config.providerOptions as
          Record<string, unknown> | undefined,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        memoryToolEnabled: config.memoryToolEnabled,
        searchToolEnabled: config.searchToolEnabled,
        searchToolConfig: config.searchToolConfig as
          Record<string, unknown> | undefined,
        extraConfig: config.extraConfig as Record<string, unknown> | undefined,
      }),
      variables,
    );

    return {
      accountId: String(scope.accountId),
      projectId: config.projectId,
      nested: nested,
    };
  },
});
