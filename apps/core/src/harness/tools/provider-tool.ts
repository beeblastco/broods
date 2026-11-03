import type { Tool } from "ai";
import { z } from "zod/mini";
import { configObject, parseOr } from "@broods/convex/model/storedJson";
import type { ToolContext } from "./index.ts";

// How the AI SDK serializes a provider tool. Its lazy schemas do not survive JSON, so only
// `id` and `args` are kept and the provider factory rebuilds the tool.
const PROVIDER_TOOL_DESCRIPTOR_TYPES = new Set([
  "provider",
  "provider-defined",
]);

// zod cannot describe a function's signature; the provider SDK owns what each factory takes.
const PROVIDER_TOOL_FACTORY = z.custom<ProviderToolFactory>(
  (value): boolean => typeof value === "function",
);

type ProviderToolFactory = (args: Record<string, unknown>) => Tool;

export interface ProviderToolBuild {
  args: Record<string, unknown>;
  factory: ProviderToolFactory;
}

// A descriptor names its tool by `id`, so its key is free, as in the AI SDK; a bare
// entry (`googleSearch: { enabled: true }`) names the factory by its key.
export function providerToolBuild(
  toolName: string,
  context: ToolContext,
): ProviderToolBuild {
  const factories = providerToolFactories(context.modelProvider);
  const id = descriptorId(context.config);
  const factory =
    id === undefined
      ? parseOr(PROVIDER_TOOL_FACTORY, factories[toolName])
      : factoryById(factories, id);
  if (!factory) {
    const asked = id === undefined ? "" : ` (${id})`;
    throw new Error(
      `config.tools.${toolName}${asked} is not a provider-defined tool on config.model.provider '${context.modelProviderName}' ` +
        `(available: ${availableToolNames(factories, id !== undefined)}). ` +
        `Connect an MCP server for anything the provider does not execute itself.`,
    );
  }

  return { args: providerToolArgs(context.config), factory: factory };
}

function availableToolNames(
  factories: Record<string, unknown>,
  byId: boolean,
): string {
  const names = Object.entries(factories)
    .map(([name, factory]): string | undefined =>
      byId ? factoryId(factory) : name,
    )
    .filter((name): name is string => name !== undefined)
    .sort();

  return names.length > 0 ? names.join(", ") : "none";
}

function descriptorId(config: Record<string, unknown>): string | undefined {
  const { type, id } = config;

  return typeof type === "string" &&
    PROVIDER_TOOL_DESCRIPTOR_TYPES.has(type) &&
    typeof id === "string"
    ? id
    : undefined;
}

function factoryById(
  factories: Record<string, unknown>,
  id: string,
): ProviderToolFactory | undefined {
  for (const value of Object.values(factories)) {
    const factory = parseOr(PROVIDER_TOOL_FACTORY, value);
    if (factory && factoryId(factory) === id) return factory;
  }

  return undefined;
}

// Building a provider tool only records its args, so an empty build reads the factory's id.
function factoryId(value: unknown): string | undefined {
  const factory = parseOr(PROVIDER_TOOL_FACTORY, value);
  if (!factory) return undefined;
  try {
    const built = factory({});

    return built.type === "provider" ? built.id : undefined;
  } catch {
    return undefined;
  }
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
