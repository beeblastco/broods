/**
 * Tool service helpers for naming, defaults, and agent config synchronization.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Reserved built-in tool names that custom tools cannot claim directly. */
const RESERVED_TOOL_NAMES = new Set(["memory", "subAgent"]);

/** Maximum custom tool function name length for provider compatibility. */
const MAX_TOOL_NAME_LENGTH = 64;

/** Convert an arbitrary label into a provider-safe tool function name. */
export function normalizeToolName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const normalized = trimmed
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  let base = normalized.length > 0 ? normalized : "tool";
  if (!/^[a-z]/.test(base)) {
    base = `tool_${base}`;
  }
  if (RESERVED_TOOL_NAMES.has(base)) {
    base = `${base}_tool`;
  }

  return base.slice(0, MAX_TOOL_NAME_LENGTH);
}

/** Ensure a unique tool name within a scope by appending numeric suffixes. */
export function makeUniqueToolName(baseName: string, usedNames: Set<string>): string {
  let candidate = baseName.slice(0, MAX_TOOL_NAME_LENGTH);
  if (!usedNames.has(candidate)) {
    return candidate;
  }

  let index = 2;
  while (usedNames.has(candidate)) {
    const suffix = `_${index}`;
    const prefix = baseName.slice(0, Math.max(1, MAX_TOOL_NAME_LENGTH - suffix.length));
    candidate = `${prefix}${suffix}`;
    index += 1;
  }

  return candidate;
}

/** Generate default starter code for newly created custom tools. */
export function defaultToolSourceCode(
  language: "javascript" | "python",
): string {
  if (language === "python") {
    return [
      `async def handler(input):`,
      `    # Sandbox entrypoint: this function is called as handler(input).`,
      `    # Vercel AI SDK docs:`,
      `    # - https://ai-sdk.dev/docs/foundations/tools`,
      `    # - https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling`,
      `    #`,
      `    # You can return either:`,
      `    # 1) Plain data (str/dict/list/int/float/bool/None).`,
      `    #    - str -> { type: "text", value: "..." }`,
      `    #    - everything else -> { type: "json", value: ... }`,
      `    # 2) Full ToolResultOutput dict (recommended when you need control), e.g.`,
      `    #    { "type": "text", "value": "done" }`,
      `    #    { "type": "json", "value": { "ok": True } }`,
      `    #    {`,
      `    #      "type": "content",`,
      `    #      "value": [`,
      `    #        {`,
      `    #          "type": "image-data",`,
      `    #          "data": "<base64>",`,
      `    #          "mediaType": "image/png",`,
      `    #        }`,
      `    #      ],`,
      `    #    }`,
      `    #`,
      `    # Raise an exception to return a tool error.`,
      `    return {`,
      `        "type": "json",`,
      `        "value": {`,
      `            "tool": "custom_tool",`,
      `            "received": input,`,
      `            "message": "Tool executed inside sandbox process.",`,
      `        },`,
      `    }`,
      "",
    ].join("\n");
  }

  return [
    `export async function handler(input) {`,
    `  // Sandbox entrypoint: this function is called as handler(input).`,
    `  // Vercel AI SDK docs:`,
    `  // - https://ai-sdk.dev/docs/foundations/tools`,
    `  // - https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling`,
    `  //`,
    `  // You can return either:`,
    `  // 1) Plain values (string/object/array/number/boolean/null).`,
    `  //    - string -> { type: "text", value: "..." }`,
    `  //    - everything else -> { type: "json", value: ... }`,
    `  // 2) Full ToolResultOutput object (recommended when you need control), e.g.`,
    `  //    { type: "text", value: "done" }`,
    `  //    { type: "json", value: { ok: true } }`,
    `  //    {`,
    `  //      type: "content",`,
    `  //      value: [`,
    `  //        { type: "image-data", data: "<base64>", mediaType: "image/png" },`,
    `  //      ],`,
    `  //    }`,
    `  //`,
    `  // Throw an Error to return a tool error.`,
    `  return {`,
    `    type: "json",`,
    `    value: {`,
    `      tool: "custom_tool",`,
    `      received: input,`,
    `      message: "Tool executed inside sandbox process.",`,
    `    },`,
    `  };`,
    `}`,
    "",
    "export default handler;",
    "",
  ].join("\n");
}

/** Preserve list order while appending new unique values. */
function appendUnique(items: string[], value: string): void {
  if (!items.includes(value)) {
    items.push(value);
  }
}

/** Merge tool names into a list after clearing known names. */
function mergeToolList(
  existing: string[] | undefined,
  namesToClear: Set<string>,
  namesToAdd: string[],
): string[] | undefined {
  const next = (existing ?? []).filter((name) => !namesToClear.has(name));
  for (const name of namesToAdd) {
    appendUnique(next, name);
  }

  // Keep undefined when this list has never been configured.
  if (existing === undefined && next.length === 0) {
    return undefined;
  }

  return next;
}

/** Compare optional string arrays with order sensitivity. */
function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }

  return a.every((value, index) => value === b[index]);
}

/**
 * Reconcile agent allowedTools lists for all custom tools in an environment.
 * Uses current agentConnections as the source of truth for which tools are attached.
 */
export async function syncAgentToolPermissionsForEnvironment(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    environmentId: Id<"environments">;
    extraToolNamesToClear?: string[];
  },
): Promise<void> {
  const { projectId, environmentId, extraToolNamesToClear = [] } = args;

  const toolServices = await ctx.db
    .query("toolServices")
    .withIndex("by_projectId_and_environmentId", (q) =>
      q.eq("projectId", projectId).eq("environmentId", environmentId),
    )
    .collect();

  const toolsByNodeId = new Map(toolServices.map((tool) => [tool.nodeId, tool]));
  const toolNamesToClear = new Set<string>([
    ...toolServices.map((tool) => tool.name),
    ...extraToolNamesToClear,
  ]);

  const agentConfigs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_environmentId", (q) =>
      q.eq("projectId", projectId).eq("environmentId", environmentId),
    )
    .collect();

  for (const agentConfig of agentConfigs) {
    const connections = await ctx.db
      .query("agentConnections")
      .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", agentConfig._id))
      .collect();

    const connectedToolNodeIds = Array.from(
      new Set(
        connections
          .filter((connection) => connection.targetType === "tool")
          .map((connection) => connection.targetId),
      ),
    );

    const enabledToolNames: string[] = [];

    for (const nodeId of connectedToolNodeIds) {
      const toolService = toolsByNodeId.get(nodeId);
      if (!toolService) {
        continue;
      }
      if (toolService.status === "enabled") {
        appendUnique(enabledToolNames, toolService.name);
      }
    }

    const nextAllowedTools = mergeToolList(
      agentConfig.allowedTools,
      toolNamesToClear,
      enabledToolNames,
    );

    if (!arraysEqual(agentConfig.allowedTools, nextAllowedTools)) {
      await ctx.db.patch(agentConfig._id, {
        allowedTools: nextAllowedTools,
        updatedAt: Date.now(),
      });
    }
  }
}
