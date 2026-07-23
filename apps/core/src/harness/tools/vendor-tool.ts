/**
 * Vendored AI SDK tool packages.
 * These are client-executed tools whose code core ships and runs in its own
 * process — unlike provider-defined tools (executed by the model provider) and
 * uploaded custom tools (tenant code confined to the V8 isolate). They exist
 * because their packages need Node (Tavily pulls axios + https-proxy-agent), so
 * the isolate tier cannot host them.
 *
 * Adding a package from the AI SDK tool registry is one dependency plus one
 * entry below. Packages load on first use so an agent that configures none does
 * not pay their import cost at boot.
 */

import type { ToolSet } from "ai";
import { optionalEnv } from "../../shared/env.ts";
import type { ToolContext } from "./index.ts";

type VendoredToolFactory = (
  options: Record<string, unknown>,
) => ToolSet[string];

interface VendoredToolPackage {
  // Service credential, shared by every tool in the package. Read from
  // config.tools.<name>.apiKey first, then this env var as a service fallback.
  apiKeyEnv: string;
  toolNames: readonly string[];
  load: () => Promise<Record<string, unknown>>;
  // Per-tool option defaults, applied under the agent's own config. Only for
  // tools where core's preferred defaults differ from the package's.
  defaults?: Record<string, Record<string, unknown>>;
}

const VENDORED_PACKAGES: readonly VendoredToolPackage[] = [
  {
    apiKeyEnv: "TAVILY_API_KEY",
    toolNames: ["tavilyCrawl", "tavilyExtract", "tavilyMap", "tavilySearch"],
    load: () => import("@tavily/ai-sdk"),
    defaults: {
      tavilyExtract: { extractDepth: "advanced", format: "markdown" },
      tavilySearch: {
        searchDepth: "advanced",
        includeAnswer: true,
        maxResults: 5,
        topic: "general",
      },
    },
  },
];

const PACKAGE_BY_TOOL_NAME = new Map(
  VENDORED_PACKAGES.flatMap((vendored) =>
    vendored.toolNames.map((name) => [name, vendored] as const),
  ),
);

export function isVendoredToolName(toolName: string): boolean {
  return PACKAGE_BY_TOOL_NAME.has(toolName);
}

export function vendoredToolNames(): string[] {
  return [...PACKAGE_BY_TOOL_NAME.keys()].sort();
}

export async function vendoredTool(
  toolName: string,
  context: ToolContext,
): Promise<ToolSet> {
  const vendored = PACKAGE_BY_TOOL_NAME.get(toolName);
  if (!vendored) {
    throw new Error(`config.tools.${toolName} is not a vendored tool`);
  }

  const { apiKey, ...options } = context.config;
  const resolvedApiKey =
    typeof apiKey === "string" ? apiKey : optionalEnv(vendored.apiKeyEnv);
  if (!resolvedApiKey) {
    throw new Error(
      `config.tools.${toolName}.apiKey or ${vendored.apiKeyEnv} is required.`,
    );
  }

  const factory = (await vendored.load())[toolName];
  if (typeof factory !== "function") {
    throw new Error(
      `config.tools.${toolName} is missing from its vendored package`,
    );
  }

  return {
    [toolName]: (factory as VendoredToolFactory)({
      apiKey: resolvedApiKey,
      ...vendored.defaults?.[toolName],
      ...options,
    }),
  };
}
