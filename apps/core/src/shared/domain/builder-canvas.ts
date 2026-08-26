/**
 * Builder tool payloads: the model-facing canvas snapshot and op results the
 * config plane returns. Pure data — no runtime behavior lives here.
 */

export interface BuilderCanvasNode {
  id: string;
  type: string;
  label?: string;
  status?: string;
  description?: string;
  /** Present on agent nodes: the dashboard's editable config row. */
  agentConfigId?: string;
  /** Present on workspace/sandbox nodes: the backing resource row. */
  resourceId?: string;
}

export interface BuilderCanvasEdge {
  id: string;
  source: string;
  target: string;
}

export interface BuilderCanvasSnapshot {
  projectId: string;
  stageId: string;
  nodes: BuilderCanvasNode[];
  edges: BuilderCanvasEdge[];
}

export interface BuilderOpResult {
  nodeId?: string;
  configId?: string;
  detail: string;
}

export interface BuilderAddAgentInput {
  name: string;
  description?: string;
  systemPrompt?: string;
  modelId?: string;
  connectFromNodeId?: string;
}

export interface BuilderUpdateNodeInput {
  nodeId: string;
  label?: string;
  description?: string;
  systemPrompt?: string;
}

export interface BuilderConnectNodesInput {
  sourceNodeId: string;
  targetNodeId: string;
}

// ---------------------------------------------------------------------------
// Skill draft / test types
// ---------------------------------------------------------------------------

export interface BuilderDraftSkillInput {
  name: string;
  description: string;
  content: string;
}

export interface BuilderDraftSkillResult {
  type: "draftSkill";
  valid: boolean;
  name: string;
  description: string;
  content: string;
  skillPath: string;
  errors?: string[];
  detail: string;
}

export interface BuilderTestSkillInput {
  name: string;
  description: string;
  content: string;
  prompts: string[];
}

export interface BuilderTestSkillPrompt {
  prompt: string;
  status: "validated" | "error";
  error?: string;
}

export interface BuilderTestSkillResult {
  type: "testSkill";
  valid: boolean;
  name: string;
  skillPath: string;
  prompts: BuilderTestSkillPrompt[];
  detail: string;
}

export interface BuilderCommitSkillInput {
  skillPath: string;
  name: string;
  description: string;
  connectFromNodeId?: string;
}

// ---------------------------------------------------------------------------
// Channel connection types
// ---------------------------------------------------------------------------

export type BuilderChannelKind =
  | "telegram"
  | "slack"
  | "discord"
  | "github"
  | "pancake"
  | "zalo";

export interface BuilderConnectChannelInput {
  agentNodeId: string;
  channel: BuilderChannelKind;
  credentials: Record<string, string>;
}
