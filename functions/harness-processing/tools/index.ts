// Tool loader for harness-processing: auto-discovers *.tool.ts files and merges them into one AI SDK ToolSet.
import type { ToolSet } from "ai";

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true }): Record<string, unknown>;
  }
}

export interface ToolContext {
  conversationKey: string;
  latestUserMessage: string;
}

type ToolFactory = (context: ToolContext) => ToolSet;
type ToolModule = {
  default?: ToolFactory;
  createTools?: ToolFactory;
};

const toolModules = import.meta.glob("./*.tool.ts", { eager: true }) as Record<string, ToolModule>;

export function createTools(context: ToolContext): ToolSet {
  const tools: ToolSet = {};

  for (const [path, module] of Object.entries(toolModules)) {
    const factory = module.default ?? module.createTools;
    if (!factory) {
      throw new Error(`Tool module ${path} must export a default tool factory`);
    }
    Object.assign(tools, factory(context));
  }

  return tools;
}
