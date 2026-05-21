/**
 * Channel lifecycle component registry.
 * Keep plugin-style component selection here, separate from provider adapters.
 */

import type { AgentConfig } from "../../_shared/accounts.ts";
import { createChannelLifecycleComponent } from "../../_components/index.ts";
import type { ChannelLifecycleComponent } from "./types.ts";

export type { ChannelLifecycleComponent, ChannelLifecycleContext } from "./types.ts";

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

function getChannelOptions(config: AgentConfig, channelName: string): Record<string, unknown> {
  const channelConfig = recordValue(config.channels?.[channelName]);
  return recordValue(channelConfig?.options) ?? {};
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
