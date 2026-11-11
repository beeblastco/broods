import { z } from "zod/mini";

// Manifest branches `agent get` prints, read leniently: one that does not fit prints as none.
export const CONFIG_BRANCH = z.record(z.string(), z.unknown());
export const SUBAGENT_REFS = z.looseObject({ allowed: z.array(z.unknown()) });
export const WEBHOOK_LIST = z.looseObject({ webhooks: z.array(z.unknown()) });

export function agentModelLabel(config: Record<string, unknown>): string {
  const model = CONFIG_BRANCH.safeParse(config.model).data ?? {};
  const provider =
    typeof model.provider === "string" ? model.provider : undefined;
  const modelId = typeof model.modelId === "string" ? model.modelId : undefined;
  if (provider && modelId) return `${provider}/${modelId}`;

  return modelId ?? provider ?? "unconfigured model";
}
