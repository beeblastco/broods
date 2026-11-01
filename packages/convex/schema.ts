import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { DEPLOYMENT_REGIONS } from "./cli/types";
import { canvasEdgeValidator, canvasNodeValidator } from "./model/canvasShapes";
import { CONNECTION_TYPE_NAMES } from "./model/connections";
import { policyDocumentValidator } from "./model/policyDocument";
import { principalLinkValidator } from "./model/principal";
import { SANDBOX_PROVIDERS } from "./model/sandboxProviders";
import { handbackValidator } from "./model/subagentResults";

export const planValidator = v.union(v.literal("free"), v.literal("pro"));

// cli: next CLI sync overwrites dashboard edits; api: dashboard locked; dashboard/unset: no prune.
const managedByValidator = v.optional(
  v.union(v.literal("cli"), v.literal("dashboard"), v.literal("api")),
);

export const usersFields = {
  authId: v.string(),
  email: v.string(),
  name: v.string(),
  avatarUrl: v.optional(v.string()),
  accountHandle: v.optional(v.string()),
  nameEdited: v.optional(v.boolean()),
  // Display only: limits read `orgs.plan`.
  plan: planValidator,
  deletionScheduledFor: v.optional(v.number()),
  workosDeletionRequestedAt: v.optional(v.number()),
  workosDeletionAttempts: v.optional(v.number()),
  activeOrgId: v.optional(v.id("orgs")),
};

export const projectsFields = {
  authId: v.string(),
  orgId: v.id("orgs"),
  name: v.string(),
  description: v.optional(v.string()),
  slug: v.string(),
  updatedAt: v.number(),
};

export const deploymentRegionValidator = v.union(
  ...DEPLOYMENT_REGIONS.map((region) => v.literal(region)),
);

export const stagesFields = {
  authId: v.string(),
  projectId: v.id("projects"),
  name: v.string(),
  kind: v.union(
    v.literal("development"),
    v.literal("production"),
    v.literal("custom"),
  ),
  deploymentRegion: v.optional(deploymentRegionValidator),
  isDefault: v.boolean(),
  updatedAt: v.number(),
};

// Its own table so a manifest sync never invalidates subscriptions on `stages`.
export const stageSyncsFields = {
  stageId: v.id("stages"),
  revision: v.number(),
  activeUntil: v.optional(v.number()),
};

export const agentConfigsFields = {
  authId: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  agentId: v.optional(v.string()),
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  provider: v.optional(v.string()),
  modelId: v.optional(v.string()),
  systemPrompt: v.optional(v.string()),
  maxTurns: v.optional(v.number()),
  allowedTools: v.optional(v.array(v.string())),
  permissionMode: v.optional(v.string()),
  outputFormat: v.optional(v.any()),
  providerOptions: v.optional(v.any()),
  temperature: v.optional(v.number()),
  maxTokens: v.optional(v.number()),
  memoryToolEnabled: v.optional(v.boolean()),
  searchToolEnabled: v.optional(v.boolean()),
  searchToolConfig: v.optional(v.any()),
  runtimeVariables: v.optional(
    v.array(v.object({ key: v.string(), value: v.string() })),
  ),
  // Plaintext: secrets only as `${ENV_NAME}` placeholders resolved from runtime secrets.
  extraConfig: v.optional(v.any()),
  managedBy: managedByValidator,
  updatedAt: v.number(),
};

// `digest` skips rewriting an unchanged row: a fresh IV would dirty the forwarder subscription.
export const channelEndpointsFields = {
  accountId: v.id("accounts"),
  agentId: v.string(),
  agentName: v.string(),
  apiUrl: v.optional(v.string()),
  digest: v.string(),
  endpointId: v.string(),
  platform: v.string(),
  tokenCiphertext: v.string(),
  tokenIv: v.string(),
  tokenTag: v.string(),
  updatedAt: v.number(),
  webhookPath: v.string(),
};

export const agentRuntimeSecretsFields = {
  agentConfigId: v.id("agentConfigs"),
  ciphertext: v.string(),
  iv: v.string(),
  tag: v.string(),
  updatedAt: v.number(),
};

export const canvasLayoutsFields = {
  authId: v.string(),
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  nodes: v.array(canvasNodeValidator),
  edges: v.array(canvasEdgeValidator),
  updatedAt: v.number(),
};

export const agentDeploymentsFields = {
  authId: v.string(),
  accountId: v.id("accounts"),
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  status: v.union(v.literal("active"), v.literal("revoked")),
  endpointId: v.string(),
  projectSlug: v.string(),
  stageSlug: v.string(),
  apiKeyHash: v.string(),
  keyHint: v.string(),
  // Sealed copy so the owner can recover the key without rotating; the hash authenticates.
  apiKeyCiphertext: v.string(),
  apiKeyIv: v.string(),
  apiKeyTag: v.string(),
  createdAt: v.optional(v.number()),
  createdBy: v.optional(v.string()),
  createdByUserId: v.optional(v.id("users")),
  lastUsedAt: v.optional(v.number()),
  // Sealed, not hashed: core needs the plaintext to check the HMAC. Never revealed after mint.
  userTokenSecretCiphertext: v.optional(v.string()),
  userTokenSecretIv: v.optional(v.string()),
  userTokenSecretTag: v.optional(v.string()),
  userTokenSecretHint: v.optional(v.string()),
  userTokenSecretCreatedAt: v.optional(v.number()),
  updatedAt: v.number(),
};

export const deployKeysFields = {
  accountId: v.id("accounts"),
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  name: v.string(),
  description: v.optional(v.string()),
  keyHash: v.string(),
  keyHint: v.string(),
  status: v.union(v.literal("active"), v.literal("revoked")),
  lastUsedAt: v.optional(v.number()),
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const accountApiKeysFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  name: v.string(),
  description: v.optional(v.string()),
  keyHash: v.string(),
  keyHint: v.string(),
  policy: policyDocumentValidator,
  expiresAt: v.optional(v.number()),
  lastUsedAt: v.optional(v.number()),
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const cliAuthCodesFields = {
  codeHash: v.string(),
  authId: v.string(),
  orgId: v.id("orgs"),
  accountId: v.id("accounts"),
  codeChallenge: v.string(),
  expiresAt: v.number(),
  usedAt: v.optional(v.number()),
  createdAt: v.number(),
};

export const cliTokensFields = {
  tokenHash: v.string(),
  authId: v.string(),
  orgId: v.id("orgs"),
  accountId: v.id("accounts"),
  status: v.union(v.literal("active"), v.literal("revoked")),
  expiresAt: v.optional(v.number()),
  createdAt: v.number(),
  lastUsedAt: v.optional(v.number()),
};

export const cliExternalResourcesFields = {
  accountId: v.id("accounts"),
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  kind: v.union(v.literal("skill"), v.literal("hook"), v.literal("mcp")),
  name: v.string(),
  description: v.optional(v.string()),
  externalId: v.string(),
  config: v.any(),
  updatedAt: v.number(),
};

export const mcpFields = {
  accountId: v.id("accounts"),
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  name: v.string(),
  description: v.optional(v.string()),
  transport: v.union(
    v.literal("http"),
    v.literal("hosted"),
    v.literal("machine"),
  ),
  url: v.optional(v.string()),
  sandbox: v.optional(v.string()),
  command: v.optional(v.array(v.string())),
  workersCompatible: v.optional(v.boolean()),
  runtime: v.optional(v.union(v.literal("auto"), v.literal("lambda"))),
  bundleStorageKey: v.optional(v.string()),
  sha256: v.optional(v.string()),
  // Values may be `${NAME}` refs resolved at sync, so secrets never sit on this row.
  headers: v.optional(v.record(v.string(), v.string())),
  oauth: v.optional(
    v.object({
      clientId: v.string(),
      clientSecret: v.string(),
      refreshToken: v.string(),
      tokenUrl: v.optional(v.string()),
    }),
  ),
  allowedTools: v.optional(v.array(v.string())),
  disabled: v.optional(v.boolean()),
  nodeId: v.optional(v.string()),
  sourceCode: v.optional(v.string()),
  status: v.union(v.literal("active"), v.literal("deleted")),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt: v.optional(v.number()),
};

export const accountHookEventValidator = v.union(
  v.literal("agent.started"),
  v.literal("agent.step.finished"),
  v.literal("agent.finished"),
  v.literal("agent.failed"),
  v.literal("agent.approval.required"),
  v.literal("tool.call.started"),
  v.literal("tool.call.finished"),
  v.literal("tool.result"),
  v.literal("subagent.task.started"),
  v.literal("subagent.task.finished"),
  v.literal("channel.message.received"),
  v.literal("channel.message.sending"),
);

export const accountHooksFields = {
  accountId: v.id("accounts"),
  name: v.string(),
  description: v.optional(v.string()),
  events: v.array(accountHookEventValidator),
  bundleStorageKey: v.string(),
  sha256: v.string(),
  status: v.union(v.literal("active"), v.literal("deleted")),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt: v.optional(v.number()),
};

export const agentPoliciesFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  name: v.string(),
  description: v.optional(v.string()),
  document: policyDocumentValidator,
  status: v.union(v.literal("active"), v.literal("deleted")),
  managedBy: managedByValidator,
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt: v.optional(v.number()),
};

export const accountRolesFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  roleId: v.string(),
  name: v.string(),
  status: v.union(v.literal("active"), v.literal("disabled")),
  policy: policyDocumentValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const roleSessionsFields = {
  tokenHash: v.string(),
  roleId: v.string(),
  accountId: v.id("accounts"),
  expiresAt: v.number(),
  createdAt: v.number(),
};

export const channelRecordsFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  platform: v.string(),
  externalId: v.string(),
  workspaceRef: v.optional(v.string()),
  name: v.string(),
  description: v.optional(v.string()),
  config: v.any(),
  status: v.union(v.literal("active"), v.literal("deleted")),
  managedBy: managedByValidator,
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt: v.optional(v.number()),
};

export const orgsFields = {
  name: v.string(),
  slug: v.string(),
  ownerAuthId: v.string(),
  plan: planValidator,
  createdAt: v.number(),
  onboardedAt: v.optional(v.number()),
};

export const orgMembersFields = {
  orgId: v.id("orgs"),
  userId: v.id("users"),
  role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
  roleId: v.optional(v.id("orgRoles")),
  invitedBy: v.optional(v.id("users")),
  createdAt: v.number(),
};

export const permissionsFields = {
  accountId: v.id("accounts"),
  name: v.string(),
  description: v.optional(v.string()),
  resource: v.string(),
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const orgRolesFields = {
  orgId: v.id("orgs"),
  name: v.string(),
  description: v.optional(v.string()),
  policyIds: v.array(v.id("agentPolicies")),
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const accountsFields = {
  orgId: v.string(),
  username: v.string(),
  description: v.optional(v.string()),
  secretHash: v.string(),
  secretHint: v.optional(v.string()),
  secretRotatedAt: v.optional(v.number()),
  secretRotatedBy: v.optional(v.id("users")),
  status: v.union(v.literal("active"), v.literal("disabled")),
  auditRetentionDays: v.optional(v.number()),
  // sts:ExternalId minted by Broods, never by the customer, so no other account can name it.
  storageExternalId: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

// The newest row without `retiredAt` seals new blobs; a retired key opens nothing.
export const accountKeysFields = {
  accountId: v.id("accounts"),
  keyId: v.string(),
  kekId: v.string(),
  wrappedKey: v.string(),
  createdAt: v.number(),
  retiredAt: v.optional(v.number()),
};

export const agentsFields = {
  accountId: v.id("accounts"),
  name: v.string(),
  description: v.optional(v.string()),
  encryptedConfig: v.optional(v.string()),
  encryptionIv: v.optional(v.string()),
  encryptionTag: v.optional(v.string()),
  encryptedSourceConfig: v.optional(v.string()),
  sourceEncryptionIv: v.optional(v.string()),
  sourceEncryptionTag: v.optional(v.string()),
  // Outside the config so a config sync never flips it; unset (older rows) means off.
  requireUserToken: v.optional(v.boolean()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const sandboxConfigsFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  name: v.string(),
  description: v.optional(v.string()),
  encryptedConfig: v.optional(v.string()),
  encryptionIv: v.optional(v.string()),
  encryptionTag: v.optional(v.string()),
  encryptedSourceConfig: v.optional(v.string()),
  sourceEncryptionIv: v.optional(v.string()),
  sourceEncryptionTag: v.optional(v.string()),
  runtimeVariables: v.optional(
    v.array(v.object({ key: v.string(), value: v.string() })),
  ),
  snapshotId: v.optional(v.string()),
  managedBy: managedByValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const sandboxProviderValidator = v.union(
  ...SANDBOX_PROVIDERS.map((name) => v.literal(name)),
);

export const sandboxSpecsValidator = v.object({
  vcpu: v.number(),
  memoryMb: v.number(),
  storageGb: v.optional(v.number()),
});

export const sandboxInstancesFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  provider: sandboxProviderValidator,
  reservationKey: v.string(),
  sandboxConfigId: v.optional(v.id("sandboxConfigs")),
  externalId: v.string(),
  name: v.string(),
  // Only the dashboard writes `suspending`; broods writes only the terminal states.
  status: v.union(
    v.literal("running"),
    v.literal("suspending"),
    v.literal("suspended"),
    v.literal("terminating"),
    v.literal("error"),
  ),
  errorMessage: v.optional(v.string()),
  snapshotId: v.optional(v.string()),
  egress: v.optional(
    v.union(
      v.literal("allow-all"),
      v.literal("deny-all"),
      v.literal("restricted"),
    ),
  ),
  permissionMode: v.optional(
    v.union(v.literal("edit"), v.literal("ask"), v.literal("bypass")),
  ),
  specs: sandboxSpecsValidator,
  specsVerified: v.optional(v.boolean()),
  createdAt: v.number(),
  lastUsedAt: v.number(),
  createdByTraceId: v.optional(v.string()),
  createdByTaskId: v.optional(v.string()),
  lastUsedTraceId: v.optional(v.string()),
  lastUsedTaskId: v.optional(v.string()),
  agentId: v.optional(v.string()),
  conversationKey: v.optional(v.string()),
  workspaceName: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  suspendedAt: v.optional(v.number()),
  idleTimeoutSeconds: v.optional(v.number()),
  // The guest reports running totals since boot, so the meter bills the growth past this.
  burstBilled: v.optional(
    v.object({ vcpuSeconds: v.number(), gbSeconds: v.number() }),
  ),
  ownCredentials: v.optional(v.boolean()),
  meteredUntil: v.optional(v.number()),
  logStream: v.optional(v.string()),
  // Lives for one call and broods drops the row itself, so nothing may suspend or terminate it.
  ephemeral: v.optional(v.boolean()),
};

export const machineConnectionsFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  sandboxConfigId: v.id("sandboxConfigs"),
  connectionId: v.string(),
  hostname: v.optional(v.string()),
  platform: v.optional(v.string()),
  computer: v.boolean(),
  mcp: v.array(v.string()),
  specs: v.optional(sandboxSpecsValidator),
  connectedAt: v.number(),
  lastSeenAt: v.number(),
  disconnectedAt: v.optional(v.number()),
};

// A snapshot holds its sandbox's disk: only the same scope boots it; an unscoped row boots nowhere.
export const sandboxSnapshotScopeValidator = v.union(
  v.literal("account"),
  v.object({ projectId: v.id("projects"), stageId: v.id("stages") }),
);

export const sandboxSnapshotsFields = {
  accountId: v.id("accounts"),
  scope: v.optional(sandboxSnapshotScopeValidator),
  name: v.string(),
  provider: sandboxProviderValidator,
  baseImage: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("building"),
    v.literal("pulling"),
    v.literal("active"),
    v.literal("inactive"),
    v.literal("error"),
    v.literal("build_failed"),
  ),
  externalImageId: v.string(),
  pulledCount: v.number(),
  createdAt: v.number(),
  lastUsedAt: v.number(),
};

// Outlives the snapshot row and the account: an image no row names would boot anywhere.
export const sandboxSnapshotImagesFields = {
  externalImageId: v.string(),
  accountId: v.id("accounts"),
  scope: v.optional(sandboxSnapshotScopeValidator),
  baseImage: v.string(),
};

export const sandboxAuditActionValidator = v.union(
  v.literal("reserve"),
  v.literal("suspend"),
  v.literal("resume"),
  v.literal("terminate"),
  v.literal("snapshot"),
  v.literal("refresh"),
  v.literal("exec"),
  v.literal("terminal"),
);

// Metadata only: never command text, provider secrets or terminal credentials.
export const sandboxAuditEventsFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  sandboxConfigId: v.optional(v.id("sandboxConfigs")),
  reservationKey: v.string(),
  provider: sandboxProviderValidator,
  action: sandboxAuditActionValidator,
  result: v.union(v.literal("ok"), v.literal("error")),
  status: v.optional(sandboxInstancesFields.status),
  actorSource: v.union(
    v.literal("dashboard"),
    v.literal("agent"),
    v.literal("service"),
    v.literal("unknown"),
  ),
  actorId: v.optional(v.string()),
  actorEmail: v.optional(v.string()),
  actorName: v.optional(v.string()),
  traceId: v.optional(v.string()),
  taskId: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  exitCode: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  truncated: v.optional(v.boolean()),
  createdAt: v.number(),
};

export const workspaceConfigsFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  name: v.string(),
  description: v.optional(v.string()),
  config: v.any(),
  // Copied from `config` on every write so an env var delete finds its users by index.
  r2AccessKeyEnv: v.optional(v.string()),
  r2SecretAccessKeyEnv: v.optional(v.string()),
  managedBy: managedByValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const environmentVariablesFields = {
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  name: v.string(),
  ciphertext: v.string(),
  iv: v.string(),
  tag: v.string(),
  // HMAC under the account key, not a bare hash, so the value is not guessable at rest.
  valueDigest: v.string(),
  updatedAt: v.number(),
};

export const accountEnvVarsFields = {
  accountId: v.id("accounts"),
  name: v.string(),
  ciphertext: v.string(),
  iv: v.string(),
  tag: v.string(),
  updatedAt: v.number(),
};

export const connectionsFields = {
  accountId: v.id("accounts"),
  type: v.union(...CONNECTION_TYPE_NAMES.map((name) => v.literal(name))),
  clientId: v.string(),
  hostId: v.string(),
  email: v.optional(v.string()),
  scopes: v.array(v.string()),
  expiresAt: v.number(),
  ciphertext: v.string(),
  iv: v.string(),
  tag: v.string(),
  updatedAt: v.number(),
};

export const environmentVariableRevealsFields = {
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  environmentVariableId: v.id("environmentVariables"),
  name: v.string(),
  source: v.union(v.literal("dashboard"), v.literal("cli")),
  revealedByAuthId: v.optional(v.string()),
  revealedByAccountId: v.optional(v.id("accounts")),
  revealedByCliTokenId: v.optional(v.id("cliTokens")),
  revealedByCliAuthId: v.optional(v.string()),
  revealedByDeployKeyId: v.optional(v.id("deployKeys")),
  revealedAt: v.number(),
};

export const auditActorKindValidator = v.union(
  v.literal("dashboardUser"),
  v.literal("apiAccountSecret"),
  v.literal("accountApiKey"),
  v.literal("admin"),
  v.literal("service"),
  v.literal("cli"),
  v.literal("deployKey"),
  v.literal("role"),
  v.literal("agent"),
);

export const auditResourceKindValidator = v.union(
  v.literal("account"),
  v.literal("accountApiKey"),
  v.literal("agent"),
  v.literal("skill"),
  v.literal("hook"),
  v.literal("mcp"),
  v.literal("workspace"),
  v.literal("workspaceFile"),
  v.literal("cron"),
  v.literal("sandbox"),
  v.literal("policy"),
  v.literal("role"),
  v.literal("channel"),
  v.literal("environmentVariable"),
  v.literal("deployment"),
  v.literal("webhook"),
  v.literal("manifest"),
  v.literal("run"),
  v.literal("tool"),
  v.literal("auditSink"),
  v.literal("unknown"),
);

// `hash` chains over `prevHash` so `verifyChain` sees any edit or removal. Details hold no secrets.
export const auditEventsFields = {
  accountId: v.id("accounts"),
  seq: v.number(),
  prevHash: v.string(),
  hash: v.string(),
  at: v.number(),
  actor: v.object({
    kind: auditActorKindValidator,
    id: v.optional(v.string()),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    agentId: v.optional(v.string()),
    chain: v.optional(v.array(principalLinkValidator)),
  }),
  action: v.string(),
  resource: v.object({
    kind: auditResourceKindValidator,
    id: v.optional(v.string()),
    name: v.optional(v.string()),
  }),
  summary: v.string(),
  detailsJson: v.optional(v.string()),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  traceId: v.optional(v.string()),
};

export const auditChainHeadsFields = {
  accountId: v.id("accounts"),
  seq: v.number(),
  hash: v.string(),
};

export const auditSinksFields = {
  accountId: v.id("accounts"),
  kind: v.literal("webhook"),
  url: v.string(),
  encryptedSecret: v.string(),
  secretIv: v.string(),
  secretTag: v.string(),
  exportedSeq: v.number(),
  lastError: v.optional(v.string()),
  updatedAt: v.number(),
};

// A webhook claims a ticket before reading Stripe; its read lands only if no later ticket has.
export const stripeSubscriptionSyncsFields = {
  stripeSubscriptionId: v.string(),
  claimed: v.number(),
  applied: v.number(),
};

export const configHttpAuthFailuresFields = {
  key: v.string(),
  windowStart: v.number(),
  count: v.number(),
  blockedUntil: v.optional(v.number()),
  updatedAt: v.number(),
};

export const workspaceFilesFields = {
  authId: v.string(),
  projectId: v.id("projects"),
  nodeId: v.string(),
  path: v.string(),
  name: v.string(),
  isFolder: v.boolean(),
  storageId: v.optional(v.id("_storage")),
  mimeType: v.optional(v.string()),
  sizeBytes: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const uploadGrantsFields = {
  accountId: v.id("accounts"),
  kind: v.union(v.literal("mcp"), v.literal("workspace")),
  createdAt: v.number(),
  expiresAt: v.number(),
};

// Not a presigned S3 URL: chat clients mangle the `+` characters in its STS token.
export const workspaceDownloadTokensFields = {
  accountId: v.id("accounts"),
  workspaceId: v.id("workspaceConfigs"),
  path: v.string(),
  filename: v.string(),
  tokenHash: v.string(),
  expiresAt: v.number(),
  createdAt: v.number(),
};

export const runtimeConversationEventsFields = {
  accountId: v.id("accounts"),
  conversationKey: v.string(),
  cursor: v.string(),
  dedupeKey: v.optional(v.string()),
  event: v.any(),
};
export const runtimeHarnessSessionsFields = {
  accountId: v.id("accounts"),
  conversationKey: v.string(),
  harnessType: v.union(
    v.literal("claude-code"),
    v.literal("codex"),
    v.literal("deepagents"),
    v.literal("opencode"),
    v.literal("pi"),
  ),
  sessionId: v.string(),
  resumeState: v.any(),
  reservationKey: v.optional(v.string()),
  updatedAt: v.number(),
};
export const runtimeClaimsFields = {
  accountId: v.id("accounts"),
  key: v.string(),
  kind: v.literal("event"),
  expiresAt: v.number(),
};
export const ingressModeValidator = v.union(
  v.literal("reject"),
  v.literal("followup"),
  v.literal("collect"),
  v.literal("steer"),
);
// Must match what `.paginate()` returns, optional fields included, or Convex rejects it.
export const paginationCursorFields = {
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(
      v.literal("SplitRecommended"),
      v.literal("SplitRequired"),
      v.null(),
    ),
  ),
};

export const ingressStatusValidator = v.union(
  v.literal("accepted"),
  v.literal("queued"),
  v.literal("applied"),
  v.literal("processing"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("expired"),
);
// `credentialAgentId`: whose channel credentials verified the delivery, when not the runner.
export const channelTargetRefsFields = {
  credentialAgentId: v.optional(v.string()),
  channelRecordId: v.optional(v.string()),
};
export const runtimeConversationCoordinatorsFields = {
  accountId: v.id("accounts"),
  agentId: v.string(),
  conversationKey: v.string(),
  channelTarget: v.optional(
    v.object({
      channelName: v.string(),
      source: v.record(v.string(), v.any()),
      ...channelTargetRefsFields,
    }),
  ),
  nextSequence: v.number(),
  ownerGeneration: v.number(),
  ownerEventId: v.optional(v.string()),
  ownerTaskId: v.optional(v.string()),
  stopRequestedGeneration: v.optional(v.number()),
  stopRequestedByParent: v.optional(v.boolean()),
  leaseExpiresAt: v.optional(v.number()),
  queuedCount: v.number(),
  queuedBytes: v.number(),
  updatedAt: v.number(),
};
export const ingressConfigRefValidator = v.object({
  model: v.optional(v.record(v.string(), v.any())),
  channel: v.optional(
    v.object({ channelName: v.string(), ...channelTargetRefsFields }),
  ),
});
export const channelIdentityValidator = v.object({
  workspaceRef: v.optional(v.string()),
  channelId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  userId: v.optional(v.string()),
  userName: v.optional(v.string()),
  userRoles: v.optional(v.array(v.string())),
});
export const systemModelMessageValidator = v.object({
  role: v.literal("system"),
  content: v.string(),
  providerOptions: v.optional(
    v.record(v.string(), v.record(v.string(), v.any())),
  ),
});
export const publicDeploymentIngressValidator = v.object({
  accountId: v.string(),
  endpointId: v.string(),
  stageSlug: v.string(),
  projectSlug: v.string(),
});
export const ingressDeliveryValidator = v.union(
  v.object({
    kind: v.literal("http"),
    publicEventId: v.string(),
    publicConversationKey: v.string(),
    statusUrl: v.optional(v.string()),
    publicDeploymentIngress: v.optional(publicDeploymentIngressValidator),
  }),
  v.object({
    kind: v.literal("async"),
    publicEventId: v.string(),
    publicConversationKey: v.string(),
    statusUrl: v.string(),
    publicDeploymentIngress: v.optional(publicDeploymentIngressValidator),
  }),
  v.object({
    kind: v.literal("websocket"),
    publicEventId: v.string(),
    publicConversationKey: v.string(),
    connectionId: v.string(),
    statusUrl: v.optional(v.string()),
    publicDeploymentIngress: v.optional(publicDeploymentIngressValidator),
  }),
  v.object({
    kind: v.literal("channel"),
    channel: v.string(),
    identity: v.optional(channelIdentityValidator),
    source: v.optional(v.record(v.string(), v.any())),
  }),
);

export const runtimeIngressEnvelopesFields = {
  accountId: v.id("accounts"),
  agentId: v.string(),
  conversationKey: v.string(),
  sequence: v.number(),
  eventId: v.string(),
  // Public id: `eventId` embeds the agent and its caller-supplied part is unique per agent only.
  runId: v.string(),
  identity: v.string(),
  idempotencyKey: v.string(),
  payloadDigest: v.string(),
  events: v.array(v.any()),
  delivery: ingressDeliveryValidator,
  requestedMode: ingressModeValidator,
  ownerTaskId: v.optional(v.string()),
  // Rebuilt into the config at dispatch, so the resolved config and its secrets never sit here.
  configRef: v.optional(ingressConfigRefValidator),
  ephemeralSystem: v.optional(v.array(systemModelMessageValidator)),
  // A queued resume marks its result stored only once applied; an expired one is left to recovery.
  resultEventId: v.optional(v.string()),
  toolResultId: v.optional(v.string()),
  appliedMode: v.optional(ingressModeValidator),
  appliedToEventId: v.optional(v.string()),
  applicationId: v.optional(v.string()),
  ownerGeneration: v.optional(v.number()),
  status: ingressStatusValidator,
  sizeBytes: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  expiresAt: v.number(),
  statusExpiresAt: v.number(),
  error: v.optional(v.string()),
  stoppedByUser: v.optional(v.boolean()),
  result: v.optional(v.any()),
};
export const runtimeIngressApplicationsFields = {
  accountId: v.id("accounts"),
  conversationKey: v.string(),
  applicationId: v.string(),
  appliedMode: ingressModeValidator,
  appliedToEventId: v.string(),
  contributingEventIds: v.array(v.string()),
  ownerGeneration: v.number(),
  createdAt: v.number(),
  expiresAt: v.number(),
};
export const asyncToolDeliveryValidator = v.union(
  v.object({ kind: v.literal("async") }),
  v.object({
    kind: v.literal("nats"),
    connectionId: v.string(),
    publicEventId: v.string(),
    publicConversationKey: v.string(),
  }),
  v.object({
    kind: v.literal("channel"),
    channelName: v.string(),
    identity: v.optional(channelIdentityValidator),
    source: v.record(v.string(), v.any()),
  }),
);
export const subagentTaskValidator = v.object({
  description: v.optional(v.string()),
  parentConversationKey: v.string(),
  parentDelivery: v.optional(asyncToolDeliveryValidator),
});
const toolApprovalSummaryValidator = v.object({
  approvalId: v.string(),
  toolCallId: v.string(),
  toolName: v.string(),
  input: v.any(),
});
const pendingQuestionSummaryValidator = v.object({
  statusId: v.string(),
  questions: v.array(
    v.object({
      id: v.string(),
      header: v.string(),
      question: v.string(),
      options: v.array(
        v.object({
          label: v.string(),
          description: v.optional(v.string()),
        }),
      ),
    }),
  ),
  answerBy: v.string(),
});
export const runtimeAsyncAgentResultsFields = {
  accountId: v.id("accounts"),
  eventId: v.string(),
  conversationKey: v.string(),
  subagent: v.optional(subagentTaskValidator),
  handback: v.optional(handbackValidator),
  status: v.union(
    v.literal("processing"),
    v.literal("awaiting_approval"),
    v.literal("awaiting_input"),
    v.literal("completed"),
    v.literal("failed"),
  ),
  response: v.optional(v.any()),
  error: v.optional(v.string()),
  approvals: v.optional(v.array(toolApprovalSummaryValidator)),
  questions: v.optional(v.array(pendingQuestionSummaryValidator)),
  createdAt: v.string(),
  updatedAt: v.string(),
  expiresAt: v.number(),
};
export const reservedSandboxValidator = v.object({
  provider: sandboxProviderValidator,
  reservationKey: v.string(),
  externalId: v.string(),
});
export const runtimeAsyncToolResultsFields = {
  accountId: v.id("accounts"),
  resultId: v.string(),
  parentEventId: v.string(),
  conversationKey: v.string(),
  toolName: v.string(),
  toolCallId: v.string(),
  input: v.any(),
  status: v.union(
    v.literal("processing"),
    v.literal("completed"),
    v.literal("failed"),
  ),
  response: v.optional(v.any()),
  error: v.optional(v.string()),
  delivery: v.optional(asyncToolDeliveryValidator),
  completionTokenHash: v.optional(v.string()),
  handback: v.optional(handbackValidator),
  // A settle after the reservation stopped naming this machine fails the row.
  sandbox: v.optional(reservedSandboxValidator),
  createdAt: v.string(),
  updatedAt: v.string(),
  expiresAt: v.number(),
};
export const sandboxReservationsFields = {
  accountId: v.id("accounts"),
  provider: sandboxProviderValidator,
  reservationKey: v.string(),
  externalId: v.string(),
  expiresAt: v.number(),
  ttlSeconds: v.optional(v.number()),
};

export const cronsFields = {
  accountId: v.id("accounts"),
  name: v.string(),
  description: v.optional(v.string()),
  agentId: v.id("agents"),
  events: v.array(v.any()),
  conversationKey: v.optional(v.string()),
  scheduleExpression: v.string(),
  timezone: v.optional(v.string()),
  status: v.union(v.literal("active"), v.literal("paused")),
  scheduledRunId: v.optional(v.id("_scheduled_functions")),
  lastInvokedAt: v.optional(v.number()),
  lastStatus: v.optional(
    v.union(v.literal("started"), v.literal("completed"), v.literal("failed")),
  ),
  lastError: v.optional(v.string()),
  // Only this run's settle may change `lastStatus`.
  lastRunId: v.optional(v.id("cronRuns")),
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const cronRunsFields = {
  accountId: v.id("accounts"),
  cronId: v.id("crons"),
  eventId: v.string(),
  conversationKey: v.string(),
  status: v.union(
    v.literal("started"),
    v.literal("completed"),
    v.literal("failed"),
  ),
  result: v.optional(v.any()),
  error: v.optional(v.string()),
  startedAt: v.number(),
  completedAt: v.optional(v.number()),
};

export const taskUsageFields = {
  accountId: v.id("accounts"),
  endpointId: v.string(),
  agentId: v.string(),
  conversationKey: v.string(),
  taskId: v.string(),
  modelProvider: v.string(),
  modelId: v.string(),
  finishedAt: v.number(),
  durationMs: v.number(),
  status: v.union(v.literal("completed"), v.literal("failed")),
  inputTokens: v.number(),
  outputTokens: v.number(),
  reasoningTokens: v.number(),
  cachedInputTokens: v.number(),
  cacheWriteTokens: v.number(),
  totalTokens: v.number(),
  runtimeKind: v.string(),
  runtimeWallMs: v.number(),
  runtimeMemoryMb: v.number(),
  sandboxUsage: v.array(
    v.object({
      type: v.string(),
      role: v.union(v.literal("agent"), v.literal("tool")),
      toolName: v.optional(v.string()),
      cpuUsec: v.number(),
    }),
  ),
  stepCount: v.number(),
  toolCallCount: v.number(),
  inputPreview: v.optional(v.string()),
};

export const usageQuantityFields = {
  sandboxVcpuSeconds: v.number(),
  sandboxGbSeconds: v.number(),
  sandboxSnapshotGb: v.number(),
  sandboxSnapshotGbMonths: v.number(),
  hostedMcpGbSeconds: v.number(),
  hostedMcpRequests: v.number(),
  workerMs: v.number(),
  workerRequests: v.number(),
  storageGbMonths: v.number(),
  egressGb: v.number(),
  ingressGb: v.number(),
};

export const usageQuantitiesValidator = v.object(usageQuantityFields);

const workerUsageFields = {
  workerMs: v.optional(v.number()),
  workerRequests: v.optional(v.number()),
};

// Quantities, not euros: a price change needs no backfill.
export const usageMetersFields = {
  accountId: v.id("accounts"),
  month: v.string(),
  ...usageQuantityFields,
  ...workerUsageFields,
  ingressGb: v.optional(v.number()),
  sandboxSnapshotGbMonths: v.optional(v.number()),
  storageGb: v.optional(v.number()),
  warnedAt: v.optional(v.number()),
  updatedAt: v.number(),
};

export const usagePoolsFields = {
  ownerAuthId: v.string(),
  month: v.string(),
  ...usageQuantityFields,
  storageGb: v.optional(v.number()),
  warnedAt: v.optional(v.number()),
  updatedAt: v.number(),
};

export const usageDaysFields = {
  accountId: v.id("accounts"),
  day: v.string(),
  ...usageQuantityFields,
  ...workerUsageFields,
  sandboxSnapshotGbMonths: v.optional(v.number()),
  storageGb: v.optional(v.number()),
  updatedAt: v.number(),
};

export const usageProjectDaysFields = {
  accountId: v.id("accounts"),
  projectId: v.id("projects"),
  day: v.string(),
  ...usageQuantityFields,
  ...workerUsageFields,
  storageGb: v.optional(v.number()),
  updatedAt: v.number(),
};

export const usageWritesFields = {
  writeId: v.string(),
  createdAt: v.number(),
};

export const modelPricesFields = {
  provider: v.string(),
  models: v.array(
    v.object({
      modelId: v.string(),
      input: v.number(),
      output: v.number(),
      cacheRead: v.number(),
      cacheWrite: v.number(),
    }),
  ),
};

export const modelPriceOverridesFields = {
  provider: v.string(),
  models: v.array(
    v.object({
      modelId: v.string(),
      input: v.number(),
      output: v.number(),
      cacheRead: v.optional(v.number()),
      cacheWrite: v.optional(v.number()),
    }),
  ),
};

export const usageRollupsFields = {
  accountId: v.id("accounts"),
  endpointId: v.string(),
  bucketStart: v.number(),
  grain: v.union(v.literal("5m"), v.literal("hour"), v.literal("day")),
  modelProvider: v.string(),
  modelId: v.string(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  reasoningTokens: v.number(),
  cachedInputTokens: v.number(),
  cacheWriteTokens: v.number(),
  totalTokens: v.number(),
  invocations: v.number(),
  modelCalls: v.number(),
  runtimeWallMs: v.number(),
  agentSandboxCpuUsec: v.number(),
  toolSandboxCpuUsec: v.number(),
  updatedAt: v.number(),
};

export default defineSchema({
  users: defineTable(usersFields)
    .index("by_authId", ["authId"])
    .index("by_accountHandle", ["accountHandle"])
    .index("by_email", ["email"]),
  projects: defineTable(projectsFields).index("by_orgId_and_slug", [
    "orgId",
    "slug",
  ]),
  stages: defineTable(stagesFields).index("by_projectId", ["projectId"]),
  stageSyncs: defineTable(stageSyncsFields).index("by_stageId", ["stageId"]),
  agentConfigs: defineTable(agentConfigsFields)
    .index("by_projectId_and_stageId", ["projectId", "stageId"])
    .index("by_agentId", ["agentId"]),
  agentRuntimeSecrets: defineTable(agentRuntimeSecretsFields).index(
    "by_agentConfigId",
    ["agentConfigId"],
  ),
  canvasLayouts: defineTable(canvasLayoutsFields).index(
    "by_projectId_and_stageId",
    ["projectId", "stageId"],
  ),
  agentDeployments: defineTable(agentDeploymentsFields)
    .index("by_projectId_and_stageId_and_status", [
      "projectId",
      "stageId",
      "status",
    ])
    .index("by_apiKeyHash", ["apiKeyHash"])
    .index("by_endpointId", ["endpointId"])
    .index("by_status", ["status"])
    .index("by_accountId_and_status", ["accountId", "status"]),
  channelEndpoints: defineTable(channelEndpointsFields)
    .index("by_accountId", ["accountId"])
    .index("by_platform", ["platform"]),
  deployKeys: defineTable(deployKeysFields)
    .index("by_keyHash", ["keyHash"])
    .index("by_projectId_and_stageId", ["projectId", "stageId"]),
  accountApiKeys: defineTable(accountApiKeysFields)
    .index("by_keyHash", ["keyHash"])
    .index("by_accountId", ["accountId"])
    .index("by_stageId", ["stageId"]),
  cliAuthCodes: defineTable(cliAuthCodesFields)
    .index("by_codeHash", ["codeHash"])
    .index("by_accountId", ["accountId"])
    .index("by_authId", ["authId"]),
  cliTokens: defineTable(cliTokensFields)
    .index("by_tokenHash", ["tokenHash"])
    .index("by_accountId", ["accountId"])
    .index("by_authId", ["authId"]),
  cliExternalResources: defineTable(cliExternalResourcesFields)
    .index("by_projectId_and_stageId", ["projectId", "stageId"])
    .index("by_accountId", ["accountId"]),
  orgs: defineTable(orgsFields)
    .index("by_slug", ["slug"])
    .index("by_ownerAuthId", ["ownerAuthId"]),
  orgMembers: defineTable(orgMembersFields)
    .index("by_userId", ["userId"])
    .index("by_orgId_and_userId", ["orgId", "userId"]),
  permissions: defineTable(permissionsFields).index("by_accountId_and_name", [
    "accountId",
    "name",
  ]),
  orgRoles: defineTable(orgRolesFields).index("by_orgId", ["orgId"]),
  accounts: defineTable(accountsFields)
    .index("by_orgId", ["orgId"])
    .index("by_secretHash", ["secretHash"]),
  accountKeys: defineTable(accountKeysFields).index("by_accountId", [
    "accountId",
  ]),
  agents: defineTable(agentsFields).index("by_accountId_and_name", [
    "accountId",
    "name",
  ]),
  accountHooks: defineTable(accountHooksFields).index(
    "by_accountId_and_status",
    ["accountId", "status"],
  ),
  mcp: defineTable(mcpFields)
    .index("by_accountId_and_status", ["accountId", "status"])
    .index("by_stageId_and_status_and_name", ["stageId", "status", "name"])
    .index("by_stageId_and_nodeId", ["stageId", "nodeId"]),
  agentPolicies: defineTable(agentPoliciesFields)
    .index("by_accountId_and_status", ["accountId", "status"])
    .index("by_stageId_and_status_and_name", ["stageId", "status", "name"]),
  accountRoles: defineTable(accountRolesFields)
    .index("by_accountId", ["accountId"])
    .index("by_roleId", ["roleId"]),
  roleSessions: defineTable(roleSessionsFields)
    .index("by_tokenHash", ["tokenHash"])
    .index("by_roleId", ["roleId"])
    .index("by_expiresAt", ["expiresAt"]),
  channelRecords: defineTable(channelRecordsFields)
    .index("by_accountId_and_status", ["accountId", "status"])
    // `status` in the key: deleted rows stay, so churn would bloat every inbound lookup.
    .index("by_accountId_platform_external", [
      "accountId",
      "platform",
      "externalId",
      "status",
    ])
    .index("by_stageId_and_name", ["stageId", "name"]),
  sandboxConfigs: defineTable(sandboxConfigsFields)
    .index("by_accountId_and_name", ["accountId", "name"])
    .index("by_stageId_and_name", ["stageId", "name"]),
  workspaceConfigs: defineTable(workspaceConfigsFields)
    .index("by_accountId_and_name", ["accountId", "name"])
    .index("by_stageId_and_name", ["stageId", "name"])
    .index("by_accountId_r2AccessKeyEnv_and_stageId", [
      "accountId",
      "r2AccessKeyEnv",
      "stageId",
    ])
    .index("by_accountId_r2SecretAccessKeyEnv_and_stageId", [
      "accountId",
      "r2SecretAccessKeyEnv",
      "stageId",
    ]),
  sandboxInstances: defineTable(sandboxInstancesFields)
    .index("by_accountId_projectId_and_stageId", [
      "accountId",
      "projectId",
      "stageId",
    ])
    .index("by_externalId", ["externalId"])
    .index("by_lastUsedAt", ["lastUsedAt"])
    .index("by_ephemeral_and_lastUsedAt", ["ephemeral", "lastUsedAt"])
    .index("by_reservationKey", ["reservationKey"])
    .index("by_sandboxConfigId", ["sandboxConfigId"]),
  machineConnections: defineTable(machineConnectionsFields)
    .index("by_accountId_projectId_and_stageId", [
      "accountId",
      "projectId",
      "stageId",
    ])
    .index("by_sandboxConfigId", ["sandboxConfigId"]),
  sandboxSnapshots: defineTable(sandboxSnapshotsFields)
    .index("by_accountId_and_name", ["accountId", "name"])
    .index("by_externalImageId_and_accountId", ["externalImageId", "accountId"])
    .index("by_status", ["status"]),
  sandboxSnapshotImages: defineTable(sandboxSnapshotImagesFields).index(
    "by_externalImageId",
    ["externalImageId"],
  ),
  sandboxAuditEvents: defineTable(sandboxAuditEventsFields).index(
    "by_accountId_and_reservationKey_and_createdAt",
    ["accountId", "reservationKey", "createdAt"],
  ),
  environmentVariables: defineTable(environmentVariablesFields)
    .index("by_projectId_and_stageId", ["projectId", "stageId"])
    .index("by_stageId_and_name", ["stageId", "name"]),
  accountEnvVars: defineTable(accountEnvVarsFields).index(
    "by_accountId_and_name",
    ["accountId", "name"],
  ),
  connections: defineTable(connectionsFields).index("by_accountId_and_type", [
    "accountId",
    "type",
  ]),
  environmentVariableReveals: defineTable(environmentVariableRevealsFields)
    .index("by_stageId", ["stageId"])
    .index("by_revealedByAuthId", ["revealedByAuthId"])
    .index("by_revealedByCliAuthId", ["revealedByCliAuthId"]),
  auditEvents: defineTable(auditEventsFields).index("by_accountId_and_seq", [
    "accountId",
    "seq",
  ]),
  auditChainHeads: defineTable(auditChainHeadsFields).index("by_accountId", [
    "accountId",
  ]),
  auditSinks: defineTable(auditSinksFields).index("by_accountId", [
    "accountId",
  ]),
  configHttpAuthFailures: defineTable(configHttpAuthFailuresFields)
    .index("by_key", ["key"])
    .index("by_updatedAt", ["updatedAt"]),
  workspaceFiles: defineTable(workspaceFilesFields)
    .index("by_projectId_nodeId_and_path", ["projectId", "nodeId", "path"])
    .index("by_storageId", ["storageId"]),
  workspaceDownloadTokens: defineTable(workspaceDownloadTokensFields)
    .index("by_tokenHash", ["tokenHash"])
    .index("by_accountId", ["accountId"])
    .index("by_expiresAt", ["expiresAt"]),
  uploadGrants: defineTable(uploadGrantsFields)
    .index("by_accountId_and_expiresAt", ["accountId", "expiresAt"])
    .index("by_expiresAt", ["expiresAt"]),
  runtimeConversationEvents: defineTable(runtimeConversationEventsFields)
    .index("by_conversationKey_and_cursor", ["conversationKey", "cursor"])
    .index("by_conversationKey_and_dedupeKey", ["conversationKey", "dedupeKey"])
    .index("by_accountId", ["accountId"]),
  runtimeHarnessSessions: defineTable(runtimeHarnessSessionsFields)
    .index("by_conversationKey", ["conversationKey"])
    .index("by_accountId", ["accountId"]),
  runtimeClaims: defineTable(runtimeClaimsFields)
    .index("by_key", ["key"])
    .index("by_accountId", ["accountId"])
    .index("by_expiresAt", ["expiresAt"]),
  runtimeConversationCoordinators: defineTable(
    runtimeConversationCoordinatorsFields,
  )
    .index("by_conversationKey", ["conversationKey"])
    .index("by_accountId", ["accountId"]),
  runtimeIngressEnvelopes: defineTable(runtimeIngressEnvelopesFields)
    .index("by_identity", ["identity"])
    .index("by_eventId", ["eventId"])
    .index("by_conversationKey_and_status_and_sequence", [
      "conversationKey",
      "status",
      "sequence",
    ])
    .index("by_conversationKey_and_appliedToEventId_and_sequence", [
      "conversationKey",
      "appliedToEventId",
      "sequence",
    ])
    .index("by_accountId_and_runId", ["accountId", "runId"])
    // Status leads: terminal rows keep a stale expiresAt a bare index would reread every sweep.
    .index("by_status_and_expiresAt", ["status", "expiresAt"])
    .index("by_status_and_statusExpiresAt", ["status", "statusExpiresAt"])
    .index("by_status_and_conversationKey", ["status", "conversationKey"]),
  runtimeIngressApplications: defineTable(runtimeIngressApplicationsFields)
    .index("by_conversationKey_and_createdAt", ["conversationKey", "createdAt"])
    .index("by_accountId", ["accountId"])
    .index("by_expiresAt", ["expiresAt"]),
  runtimeAsyncAgentResults: defineTable(runtimeAsyncAgentResultsFields)
    .index("by_eventId", ["eventId"])
    .index("by_accountId", ["accountId"])
    .index("by_conversationKey", ["conversationKey"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_handback_and_status_and_updatedAt", [
      "handback",
      "status",
      "updatedAt",
    ]),
  runtimeAsyncToolResults: defineTable(runtimeAsyncToolResultsFields)
    .index("by_resultId", ["resultId"])
    .index("by_accountId", ["accountId"])
    .index("by_conversationKey_and_toolName_and_status", [
      "conversationKey",
      "toolName",
      "status",
    ])
    .index("by_handback_and_status_and_updatedAt", [
      "handback",
      "status",
      "updatedAt",
    ])
    .index("by_expiresAt", ["expiresAt"]),
  sandboxReservations: defineTable(sandboxReservationsFields)
    .index("by_provider_and_reservationKey", ["provider", "reservationKey"])
    .index("by_accountId", ["accountId"])
    .index("by_expiresAt", ["expiresAt"]),
  crons: defineTable(cronsFields).index("by_accountId_and_agentId", [
    "accountId",
    "agentId",
  ]),
  cronRuns: defineTable(cronRunsFields).index(
    "by_accountId_and_cronId_and_startedAt",
    ["accountId", "cronId", "startedAt"],
  ),
  taskUsage: defineTable(taskUsageFields)
    .index("by_accountId_and_taskId", ["accountId", "taskId"])
    .index("by_endpointId_and_finishedAt", ["endpointId", "finishedAt"])
    .index("by_endpointId_and_modelProvider_and_modelId_and_finishedAt", [
      "endpointId",
      "modelProvider",
      "modelId",
      "finishedAt",
    ]),
  usageRollups: defineTable(usageRollupsFields)
    .index("by_endpointId_and_grain_and_bucketStart", [
      "endpointId",
      "grain",
      "bucketStart",
    ])
    .index("by_accountId_endpointId_grain_bucketStart_modelProvider_modelId", [
      "accountId",
      "endpointId",
      "grain",
      "bucketStart",
      "modelProvider",
      "modelId",
    ]),
  usageMeters: defineTable(usageMetersFields).index("by_accountId_and_month", [
    "accountId",
    "month",
  ]),
  usagePools: defineTable(usagePoolsFields).index("by_ownerAuthId_and_month", [
    "ownerAuthId",
    "month",
  ]),
  usageDays: defineTable(usageDaysFields).index("by_accountId_and_day", [
    "accountId",
    "day",
  ]),
  usageProjectDays: defineTable(usageProjectDaysFields).index(
    "by_accountId_and_day_and_projectId",
    ["accountId", "day", "projectId"],
  ),
  usageWrites: defineTable(usageWritesFields)
    .index("by_writeId", ["writeId"])
    .index("by_createdAt", ["createdAt"]),
  modelPrices: defineTable(modelPricesFields).index("by_provider", [
    "provider",
  ]),
  modelPriceOverrides: defineTable(modelPriceOverridesFields).index(
    "by_provider",
    ["provider"],
  ),
  stripeSubscriptionSyncs: defineTable(stripeSubscriptionSyncsFields).index(
    "by_stripeSubscriptionId",
    ["stripeSubscriptionId"],
  ),
});
