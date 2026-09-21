import { Bot, Box, FolderOpen, Plug, Sparkles } from "lucide-react";

/**
 * The card types the canvas can add, in "Add service" order, with the icon each
 * one wears. The card menu reads the same icons for its link rows.
 */
export const NODE_TEMPLATES = [
  { type: "agent", label: "Agent", icon: Bot },
  { type: "sandbox", label: "Sandbox", icon: Box },
  { type: "workspace", label: "Workspace", icon: FolderOpen },
  { type: "skill", label: "Skill", icon: Sparkles },
  { type: "mcp", label: "MCP", icon: Plug },
] as const;
