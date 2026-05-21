/**
 * Optional channel lifecycle component registry.
 * Keep concrete customer/channel components out of the harness runtime contract.
 */

import {
  createPancakeSupabaseReplyModeComponent,
  type PancakeSupabaseReplyModeConfig,
} from "./pancake/supabase-reply-mode.component.ts";
import type { AgentConfig } from "../_shared/accounts.ts";
import type { ChannelLifecycleComponent } from "../_shared/channels.ts";

export function createChannelLifecycleComponents(
  config: AgentConfig,
  channelName: string,
): ChannelLifecycleComponent[] {
  const channelOptions = getChannelOptions(config, channelName);
  const componentsConfig = channelOptions.components;
  if (componentsConfig === undefined) {
    return [];
  }

  if (!Array.isArray(componentsConfig)) {
    throw new Error(`config.channels.${channelName}.options.components must be an array`);
  }

  return componentsConfig
    .map((componentConfig, index) =>
      createChannelLifecycleComponent(componentConfig, `config.channels.${channelName}.options.components[${index}]`)
    )
    .filter((component): component is ChannelLifecycleComponent => component !== null);
}

export function createChannelLifecycleComponent(
  value: unknown,
  path: string,
): ChannelLifecycleComponent | null {
  const config = recordValue(value);
  if (!config || config.enabled === false) {
    return null;
  }

  switch (config.type) {
    case "pancake-supabase-reply-mode":
      return createPancakeSupabaseReplyModeComponent(parsePancakeSupabaseReplyModeConfig(config, path));
    case undefined:
      return null;
    default:
      throw new Error(`Unsupported channel lifecycle component type: ${String(config.type)}`);
  }
}

function parsePancakeSupabaseReplyModeConfig(
  config: Record<string, unknown>,
  path: string,
): PancakeSupabaseReplyModeConfig {
  const url = requiredString(config.url, `${path}.url`);
  const serviceRoleKey = requiredString(config.serviceRoleKey, `${path}.serviceRoleKey`);

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
