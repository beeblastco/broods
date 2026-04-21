// Tool registry for harness-processing: imports tool files and merges them into one AI SDK ToolSet.
import type { ToolSet } from "ai";
import weatherTool from "./weather.tool.ts";

export interface ToolContext {
  conversationKey: string;
  latestUserMessage: string;
}

type ToolFactory = (context: ToolContext) => ToolSet;
// Add new tool factories here so they are bundled into the compiled Lambda binary.
const toolFactories: ToolFactory[] = [
  weatherTool,
];

export function createTools(context: ToolContext): ToolSet {
  const tools: ToolSet = {};

  for (const factory of toolFactories) {
    Object.assign(tools, factory(context));
  }

  return tools;
}
