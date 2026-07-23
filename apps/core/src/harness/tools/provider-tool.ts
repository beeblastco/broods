/**
 * Generic provider-defined tool resolution.
 * Any config.tools key that is not an uploaded account tool id is resolved
 * against the configured AI SDK provider's `tools` namespace, so every
 * provider-executed tool a provider ships is configurable without core code.
 */

import type { ToolSet } from "ai";
import { isPlainObject } from "../../shared/object.ts";
import type { ToolContext } from "./index.ts";

// A provider tool built by the AI SDK and serialized into config by the SDK
// (`google.tools.googleSearch({...})`) arrives as this descriptor. Its lazy
// input/output schemas do not survive JSON, so only `args` is carried over and
// the provider factory rebuilds the tool with its schemas intact.
const PROVIDER_TOOL_DESCRIPTOR_TYPES = new Set([
  "provider",
  "provider-defined",
]);

type ProviderToolFactory = (args: Record<string, unknown>) => ToolSet[string];

export function providerDefinedTool(
  toolName: string,
  context: ToolContext,
): ToolSet {
  const factories = providerToolFactories(context.modelProvider);
  const factory = factories[toolName];
  if (typeof factory !== "function") {
    throw new Error(
      `config.tools.${toolName} is not a provider-defined tool on config.model.provider '${context.modelProviderName}' ` +
        `(available: ${availableToolNames(factories)}). ` +
        `Upload a custom tool for anything the provider does not execute itself.`,
    );
  }

  return { [toolName]: factory(providerToolArgs(context.config)) };
}

function availableToolNames(
  factories: Record<string, ProviderToolFactory>,
): string {
  const names = Object.keys(factories).sort();
  return names.length > 0 ? names.join(", ") : "none";
}

function providerToolArgs(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const { type, args } = config as { type?: unknown; args?: unknown };
  if (typeof type === "string" && PROVIDER_TOOL_DESCRIPTOR_TYPES.has(type)) {
    return isPlainObject(args) ? (args as Record<string, unknown>) : {};
  }
  return config;
}

// AI SDK providers are callable factories with a `tools` namespace hanging off
// them, so this reads the property off a function as well as a plain object.
function providerToolFactories(
  modelProvider: unknown,
): Record<string, ProviderToolFactory> {
  if (
    modelProvider === null ||
    (typeof modelProvider !== "object" && typeof modelProvider !== "function")
  ) {
    return {};
  }

  const tools = (modelProvider as { tools?: unknown }).tools;
  return isPlainObject(tools)
    ? (tools as Record<string, ProviderToolFactory>)
    : {};
}
