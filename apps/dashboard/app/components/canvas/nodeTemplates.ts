import type { ShortcutId } from "@/app/lib/shortcuts";
import { Bot, Box, FolderOpen, Plug, Sparkles } from "lucide-react";

export const NODE_TEMPLATES = [
  { type: "agent", label: "Agent", icon: Bot },
  { type: "sandbox", label: "Sandbox", icon: Box },
  { type: "workspace", label: "Workspace", icon: FolderOpen },
  { type: "skill", label: "Skill", icon: Sparkles },
  { type: "mcp", label: "MCP", icon: Plug },
] as const;

export type NodeType = (typeof NODE_TEMPLATES)[number]["type"];

export const NODE_TYPE_SHORTCUTS: Record<NodeType, ShortcutId> = {
  agent: "canvas.addAgent",
  mcp: "canvas.addMcp",
  sandbox: "canvas.addSandbox",
  skill: "canvas.addSkill",
  workspace: "canvas.addWorkspace",
};
