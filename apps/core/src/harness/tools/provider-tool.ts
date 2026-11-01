import type { ToolSet } from "ai";
import { isPlainObject } from "@broods/convex/model/objects";
import type { ToolContext } from "./index.ts";

// How the AI SDK serializes a provider tool. Its lazy schemas do not survive JSON, so only
// `args` is kept and the provider factory rebuilds the tool.
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
        `Connect an MCP server for anything the provider does not execute itself.`,
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

// AI SDK providers are callable factories, so `tools` can hang off a function.
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
