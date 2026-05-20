/**
 * Channel lifecycle component registry.
 * Keep plugin-style component selection here, separate from provider adapters.
 */

import type { AgentConfig } from "../../_shared/accounts.ts";
import {
  createSupabaseConversationStateComponent,
  type SupabaseConversationStateConfig,
} from "./supabase-conversation-state.plugin.ts";
import type { ChannelLifecycleComponent } from "./types.ts";

export type { ChannelLifecycleComponent, ChannelLifecycleContext } from "./types.ts";

export function createChannelLifecycleComponents(
  config: AgentConfig,
  channelName: string,
): ChannelLifecycleComponent[] {
  const channelOptions = getChannelOptions(config, channelName);
  const componentsConfig = recordValue(channelOptions.components);
  if (!componentsConfig) {
    return [];
  }

  return [
    createConversationStateComponent(componentsConfig.conversationState),
  ].filter((component): component is ChannelLifecycleComponent => component !== null);
}

function createConversationStateComponent(value: unknown): ChannelLifecycleComponent | null {
  const config = recordValue(value);
  if (!config || config.enabled === false) {
    return null;
  }

  switch (config.provider) {
    case "supabase":
      return createSupabaseConversationStateComponent(parseSupabaseConversationStateConfig(config));
    case undefined:
      return null;
    default:
      throw new Error(`Unsupported conversationState provider: ${String(config.provider)}`);
  }
}

function parseSupabaseConversationStateConfig(
  config: Record<string, unknown>,
): SupabaseConversationStateConfig {
  const url = requiredString(config.url, "conversationState.url");
  const serviceRoleKey = requiredString(config.serviceRoleKey, "conversationState.serviceRoleKey");

  return { url, serviceRoleKey };
}

function getChannelOptions(config: AgentConfig, channelName: string): Record<string, unknown> {
  const channelConfig = recordValue(config.channels?.[channelName]);
  return recordValue(channelConfig?.options) ?? {};
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
