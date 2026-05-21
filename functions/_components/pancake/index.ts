/**
 * Pancake channel component factory.
 * Keep optional Pancake-specific customer components here.
 */

import type { AgentConfig } from "../../_shared/accounts.ts";
import type { ChannelParseResult, ParsedChannelMessage } from "../../_shared/channels.ts";
import {
  applyPancakeSupabaseReplyMode,
  type PancakeSupabaseReplyModeConfig,
} from "./supabase-reply-mode.component.ts";

export interface PancakeWebhookComponentScope {
  accountId: string;
  agentId: string;
}

export interface PancakeWebhookComponent {
  apply(parsed: ParsedChannelMessage): Promise<ChannelParseResult>;
}

export function createPancakeWebhookComponent(
  config: AgentConfig,
  scope: PancakeWebhookComponentScope,
): PancakeWebhookComponent | null {
  const replyModeConfig = getPancakeSupabaseReplyModeConfig(config);
  if (!replyModeConfig) {
    return null;
  }

  return {
    apply: (parsed) => applyPancakeSupabaseReplyMode(replyModeConfig, scope, parsed),
  };
}

export function getPancakeSupabaseReplyModeConfig(
  config: AgentConfig,
): PancakeSupabaseReplyModeConfig | null {
  const channelOptions = getPancakeOptions(config);
  const componentsConfig = channelOptions.components;
  if (componentsConfig === undefined) {
    return null;
  }

  if (!Array.isArray(componentsConfig)) {
    throw new Error("config.channels.pancake.options.components must be an array");
  }

  for (let index = 0; index < componentsConfig.length; index += 1) {
    const componentConfig = recordValue(componentsConfig[index]);
    if (
      componentConfig &&
      componentConfig.enabled !== false &&
      componentConfig.type === "pancake-supabase-reply-mode"
    ) {
      return parsePancakeSupabaseReplyModeConfig(
        componentConfig,
        `config.channels.pancake.options.components[${index}]`,
      );
    }
  }

  return null;
}

function parsePancakeSupabaseReplyModeConfig(
  config: Record<string, unknown>,
  path: string,
): PancakeSupabaseReplyModeConfig {
  const url = requiredString(config.url, `${path}.url`);
  const serviceRoleKey = requiredString(config.serviceRoleKey, `${path}.serviceRoleKey`);

  return { url, serviceRoleKey };
}

function getPancakeOptions(config: AgentConfig): Record<string, unknown> {
  const channelConfig = recordValue(config.channels?.pancake);
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
