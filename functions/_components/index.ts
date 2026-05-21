/**
 * Optional channel lifecycle component registry.
 * Keep concrete customer/channel components out of the harness runtime contract.
 */

import {
  createSupabaseConversationStateComponent,
  type SupabaseConversationStateConfig,
} from "./pancake/supabase-conversation-state.component.ts";
import type { ChannelLifecycleComponent } from "../harness-processing/channel-lifecycle/types.ts";

export function createChannelLifecycleComponent(
  value: unknown,
  path: string,
): ChannelLifecycleComponent | null {
  const config = recordValue(value);
  if (!config || config.enabled === false) {
    return null;
  }

  switch (config.type) {
    case "pancake-supabase-conversation-state":
      return createSupabaseConversationStateComponent(parseSupabaseConversationStateConfig(config, path));
    case undefined:
      return null;
    default:
      throw new Error(`Unsupported channel lifecycle component type: ${String(config.type)}`);
  }
}

function parseSupabaseConversationStateConfig(
  config: Record<string, unknown>,
  path: string,
): SupabaseConversationStateConfig {
  const url = requiredString(config.url, `${path}.url`);
  const serviceRoleKey = requiredString(config.serviceRoleKey, `${path}.serviceRoleKey`);

  return { url, serviceRoleKey };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}
