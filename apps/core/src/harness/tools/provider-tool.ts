import type { ToolSet } from "ai";
import { z } from "zod/mini";
import { configObject, parseOr } from "@broods/convex/model/storedJson";
import type { ToolContext } from "./index.ts";

// How the AI SDK serializes a provider tool. Its lazy schemas do not survive JSON, so only
// `args` is kept and the provider factory rebuilds the tool.
const PROVIDER_TOOL_DESCRIPTOR_TYPES = new Set([
  "provider",
  "provider-defined",
]);

// zod cannot describe a function's signature; the provider SDK owns what each factory takes.
const PROVIDER_TOOL_FACTORY = z.custom<ProviderToolFactory>(
  (value): boolean => typeof value === "function",
);

type ProviderToolFactory = (args: Record<string, unknown>) => ToolSet[string];

export function providerDefinedTool(
  toolName: string,
  context: ToolContext,
): ToolSet {
  const factories = providerToolFactories(context.modelProvider);
  const factory = parseOr(PROVIDER_TOOL_FACTORY, factories[toolName]);
  if (!factory) {
    throw new Error(
      `config.tools.${toolName} is not a provider-defined tool on config.model.provider '${context.modelProviderName}' ` +
        `(available: ${availableToolNames(factories)}). ` +
        `Connect an MCP server for anything the provider does not execute itself.`,
    );
  }

  return { [toolName]: factory(providerToolArgs(context.config)) };
}

function availableToolNames(factories: Record<string, unknown>): string {
  const names = Object.keys(factories).sort();

  return names.length > 0 ? names.join(", ") : "none";
}

function providerToolArgs(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const { type, args } = config;
  if (typeof type === "string" && PROVIDER_TOOL_DESCRIPTOR_TYPES.has(type)) {
    return parseOr(configObject, args, {});
  }

  return config;
}

// AI SDK providers are callable factories, so `tools` can hang off a function.
function providerToolFactories(
  modelProvider: unknown,
): Record<string, unknown> {
  if (
    modelProvider === null ||
    (typeof modelProvider !== "object" && typeof modelProvider !== "function")
  ) {
    return {};
  }

  const tools = (modelProvider as { tools?: unknown }).tools;

  return parseOr(configObject, tools, {});
}
