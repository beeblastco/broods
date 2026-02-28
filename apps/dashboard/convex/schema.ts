/**
 * Convex database schema for Clonee: serverless AI agent deployment platform.
 * Field objects are exported for reuse in function args and validators.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Message role (matches AI SDK ModelMessage roles). */
export const messageRoleEnum = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("system"),
  v.literal("tool"),
);

/** Task status enum for agent execution tracking. */
export const taskStatusEnum = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("rerun"),
  v.literal("tool_call"),
  v.literal("waiting_subagent"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

/** Tool approval status enum. */
export const approvalStatusEnum = v.union(
  v.literal("pending"),
  v.literal("granted"),
  v.literal("denied"),
);

/** Approval trigger enum. */
export const approvalTriggerEnum = v.union(
  v.literal("manual"),
  v.literal("auto"),
);

/** Permission mode enum for agent tool access. */
export const permissionModeEnum = v.union(
  v.literal("default"),
  v.literal("bypassPermissions"),
);

/** Deployment status enum for externally exposed agent endpoints. */
export const deploymentStatusEnum = v.union(
  v.literal("active"),
  v.literal("revoked"),
);

/** Tool service status enum for custom tool availability. */
export const toolServiceStatusEnum = v.union(
  v.literal("enabled"),
  v.literal("disabled"),
);

/** Tool service code language enum. */
export const toolServiceLanguageEnum = v.union(
  v.literal("javascript"),
  v.literal("python"),
);

/** User pricing plan tier. */
export const planEnum = v.union(
  v.literal("hobby"),
  v.literal("developer"),
  v.literal("pro"),
);


/** Agent connection target type (matches canvas node types). */
export const agentConnectionTargetTypeEnum = v.union(
  v.literal("agent"),
  v.literal("tool"),
  v.literal("workspace"),
  v.literal("database"),
);

/** Single content part for rich message payloads. */
export const messageContentPartFields = v.union(
  v.object({
    type: v.literal("text"),
    text: v.string(),
    providerOptions: v.optional(v.any()),
  }),
  v.object({
    type: v.literal("image"),
    image: v.union(v.string(), v.bytes()),
    mediaType: v.optional(v.string()),
    providerOptions: v.optional(v.any()),
  }),
  v.object({
    type: v.literal("file"),
    data: v.any(),
    mediaType: v.string(),
    filename: v.optional(v.string()),
    providerOptions: v.optional(v.any()),
  }),
  v.object({
    type: v.literal("reasoning"),
    text: v.string(),
    providerOptions: v.optional(v.any()),
  }),
  v.object({
    type: v.literal("tool-call"),
    toolCallId: v.string(),
    toolName: v.string(),
    input: v.any(),
    providerOptions: v.optional(v.any()),
    providerExecuted: v.optional(v.boolean()),
  }),
  v.object({
    type: v.literal("tool-result"),
    toolCallId: v.string(),
    toolName: v.string(),
    output: v.any(),
    providerOptions: v.optional(v.any()),
  }),
  v.object({
    type: v.literal("tool-approval-request"),
    approvalId: v.string(),
    toolCallId: v.string(),
  }),
  v.object({
    type: v.literal("tool-approval-response"),
    approvalId: v.string(),
    approved: v.boolean(),
    reason: v.optional(v.string()),
    providerExecuted: v.optional(v.boolean()),
  }),
);

/** Message content (string or array of content parts, matches AI SDK ModelMessage). */
export const messageContentFields = v.union(
  v.string(),
  v.array(messageContentPartFields),
);

/** Users table fields. */
export const userFields = {
  authId: v.string(),
  email: v.string(),
  name: v.string(),
  accountHandle: v.optional(v.string()),
  avatarUrl: v.optional(v.string()),
  plan: v.optional(planEnum),
  deletionRequestedAt: v.optional(v.number()),
  deletionScheduledFor: v.optional(v.number()),
  isFirstTime: v.boolean(),
  updatedAt: v.number(),
};

/** Projects table fields. */
export const projectFields = {
  authId: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  slug: v.string(),
  updatedAt: v.number(),
};

/** Environment fields for project deployment environments. */
export const environmentFields = {
  authId: v.string(),
  projectId: v.id("projects"),
  name: v.string(),
  isDefault: v.boolean(),
  updatedAt: v.number(),
};

/** Agent configs table fields. */
export const agentConfigFields = {
  authId: v.string(),
  projectId: v.id("projects"),
  environmentId: v.id("environments"),
  name: v.string(),
  description: v.optional(v.string()),
  modelId: v.string(),
  systemPrompt: v.optional(v.string()),
  maxTurns: v.optional(v.number()),
  allowedTools: v.optional(v.array(v.string())),
  permissionMode: permissionModeEnum,
  outputFormat: v.optional(v.any()),
  providerOptions: v.optional(v.any()),
  temperature: v.optional(v.number()),
  maxTokens: v.optional(v.number()),
  isSubAgent: v.boolean(),
  memoryToolEnabled: v.optional(v.boolean()),
  searchToolEnabled: v.optional(v.boolean()),
  searchToolConfig: v.optional(v.object({
    searchDepth: v.optional(v.string()),
    topic: v.optional(v.string()),
    maxResults: v.optional(v.number()),
  })),
  updatedAt: v.number(),
};

/** Sessions table fields. */
export const sessionFields = {
  title: v.optional(v.string()),
  authId: v.string(),
  configId: v.optional(v.id("agentConfigs")),
  projectId: v.optional(v.id("projects")),
  parentSessionId: v.optional(v.id("sessions")),
  isSubagent: v.optional(v.boolean()),
  metadata: v.optional(v.any()),
  updatedAt: v.number(),
};

/** Messages table fields. */
export const messageFields = {
  sessionId: v.id("sessions"),
  role: messageRoleEnum,
  content: messageContentFields,
  providerOptions: v.optional(v.any()),
  metadata: v.optional(v.any()),
  updatedAt: v.number(),
};

/** Tasks table fields for agent execution tracking. */
export const taskFields = {
  type: v.union(v.literal("subagent"), v.literal("agent")),
  parentSessionId: v.optional(v.id("sessions")),
  sessionId: v.id("sessions"),
  toolCallId: v.optional(v.string()),
  workflowId: v.optional(v.string()),
  status: taskStatusEnum,
  cancelledAt: v.optional(v.number()),
  result: v.optional(v.array(v.any())),
  error: v.optional(v.string()),
  completedAt: v.optional(v.number()),
  resultDelivered: v.optional(v.boolean()),
};

/** Tool approvals table fields. */
export const toolApprovalFields = {
  sessionId: v.id("sessions"),
  approvalId: v.string(),
  toolCallId: v.string(),
  toolName: v.string(),
  toolInput: v.any(),
  status: approvalStatusEnum,
  reason: v.optional(v.string()),
  respondedAt: v.optional(v.number()),
  trigger: approvalTriggerEnum,
  workflowId: v.optional(v.string()),
};

/** Canvas node type enum. */
export const canvasNodeTypeEnum = v.union(
  v.literal("agent"),
  v.literal("database"),
  v.literal("workspace"),
  v.literal("tool"),
);

/** Canvas node status enum. */
export const canvasNodeStatusEnum = v.union(
  v.literal("running"),
  v.literal("idle"),
  v.literal("error"),
);

/** Node properties for visual customization. */
export const canvasNodePropertiesValidator = v.object({
  color: v.string(),
});

/** A single node on the canvas. */
export const canvasNodeValidator = v.object({
  id: v.string(),
  type: canvasNodeTypeEnum,
  position: v.object({ x: v.number(), y: v.number() }),
  data: v.object({
    label: v.string(),
    status: v.optional(canvasNodeStatusEnum),
    agentConfigId: v.optional(v.id("agentConfigs")),
    properties: v.optional(canvasNodePropertiesValidator),
  }),
});

/** A single edge on the canvas. */
export const canvasEdgeValidator = v.object({
  id: v.string(),
  source: v.string(),
  target: v.string(),
  animated: v.optional(v.boolean()),
});

/** Canvas layouts table fields. */
export const canvasLayoutFields = {
  authId: v.string(),
  projectId: v.id("projects"),
  environmentId: v.id("environments"),
  nodes: v.array(canvasNodeValidator),
  edges: v.array(canvasEdgeValidator),
  updatedAt: v.number(),
};

/** Agent-resource connections table fields. */
export const agentConnectionFields = {
  authId: v.string(),
  agentConfigId: v.id("agentConfigs"),
  targetType: agentConnectionTargetTypeEnum,
  targetId: v.string(),
  updatedAt: v.number(),
};

/** Agent deployment endpoint fields. */
export const agentDeploymentFields = {
  authId: v.string(),
  agentConfigId: v.id("agentConfigs"),
  endpointId: v.string(),
  projectSlug: v.optional(v.string()),
  environmentSlug: v.optional(v.string()),
  apiKey: v.optional(v.string()),
  apiKeyHash: v.string(),
  status: deploymentStatusEnum,
  revokedAt: v.optional(v.number()),
  updatedAt: v.number(),
};

/** Tool service fields for custom sandboxed tools attached to canvas nodes. */
export const toolServiceFields = {
  authId: v.string(),
  projectId: v.id("projects"),
  environmentId: v.id("environments"),
  nodeId: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  parameters: v.optional(v.any()),
  status: toolServiceStatusEnum,
  language: toolServiceLanguageEnum,
  sourceCode: v.string(),
  updatedAt: v.number(),
};


export default defineSchema({
  users: defineTable(userFields)
    .index("by_authId", ["authId"]),

  projects: defineTable(projectFields)
    .index("by_authId", ["authId"])
    .index("by_slug", ["slug"]),

  environments: defineTable(environmentFields)
    .index("by_authId", ["authId"])
    .index("by_projectId", ["projectId"])
    .index("by_projectId_and_isDefault", ["projectId", "isDefault"]),

  agentConfigs: defineTable(agentConfigFields)
    .index("by_authId", ["authId"])
    .index("by_projectId", ["projectId"])
    .index("by_projectId_and_environmentId", ["projectId", "environmentId"])
    .index("by_authId_and_name", ["authId", "name"])
    .index("by_isSubAgent_and_authId", ["isSubAgent", "authId"]),

  sessions: defineTable(sessionFields)
    .index("by_authId", ["authId"])
    .index("by_authId_and_isSubagent", ["authId", "isSubagent"])
    .index("by_projectId", ["projectId"])
    .index("by_configId", ["configId"]),

  messages: defineTable(messageFields)
    .index("by_sessionId", ["sessionId"])
    .index("by_sessionId_and_role", ["sessionId", "role"]),

  tasks: defineTable(taskFields)
    .index("by_parentSessionId", ["parentSessionId"])
    .index("by_sessionId", ["sessionId"])
    .index("by_parentSessionId_and_status", ["parentSessionId", "status"])
    .index("by_type_and_status", ["type", "status"]),

  toolApprovals: defineTable(toolApprovalFields)
    .index("by_sessionId", ["sessionId"])
    .index("by_sessionId_and_status", ["sessionId", "status"])
    .index("by_approvalId", ["approvalId"]),

  canvasLayouts: defineTable(canvasLayoutFields)
    .index("by_projectId", ["projectId"])
    .index("by_projectId_and_environmentId", ["projectId", "environmentId"]),

  agentConnections: defineTable(agentConnectionFields)
    .index("by_agentConfigId", ["agentConfigId"])
    .index("by_targetType_and_targetId", ["targetType", "targetId"]),

  toolServices: defineTable(toolServiceFields)
    .index("by_authId", ["authId"])
    .index("by_projectId", ["projectId"])
    .index("by_projectId_and_environmentId", ["projectId", "environmentId"])
    .index("by_projectId_and_environmentId_and_nodeId", ["projectId", "environmentId", "nodeId"])
    .index("by_authId_and_name", ["authId", "name"]),

  agentDeployments: defineTable(agentDeploymentFields)
    .index("by_authId", ["authId"])
    .index("by_endpointId", ["endpointId"])
    .index("by_agentConfigId", ["agentConfigId"]),

});
