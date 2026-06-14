import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Field definitions for the users table.
 * Synced from WorkOS AuthKit webhooks with app-specific extensions.
 */
export const usersFields = {
    authId: v.string(),
    email: v.string(),
    name: v.string(),
    avatarUrl: v.optional(v.string()),
    accountHandle: v.optional(v.string()),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
    deletionScheduledFor: v.optional(v.number()),
    /** Org the user last switched to. Falls back to most recent membership when unset. */
    activeOrgId: v.optional(v.id("orgs")),
};

export const projectsFields = {
    authId: v.string(),
    /** Org that owns this project. Optional only for legacy rows created before org scoping. */
    orgId: v.optional(v.id("orgs")),
    name: v.string(),
    description: v.optional(v.string()),
    slug: v.string(),
    updatedAt: v.number(),
};

export const environmentsFields = {
    authId: v.string(),
    projectId: v.id("projects"),
    name: v.string(),
    isDefault: v.boolean(),
    updatedAt: v.number(),
};

/** Minimal agent config fields; extra UI settings are stored as optional fields. */
export const agentConfigsFields = {
    authId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    agentId: v.optional(v.string()),
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
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
    publicAccessEnabled: v.optional(v.boolean()),
    webSocketEnabled: v.optional(v.boolean()),
    memoryToolEnabled: v.optional(v.boolean()),
    searchToolEnabled: v.optional(v.boolean()),
    searchToolConfig: v.optional(v.any()),
    runtimeVariables: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
    /**
     * Filthy-panty AgentConfig branches that don't live as flat columns:
     * `agent`, `workspace`, `session`, `hooks`, `channels`, `tools`, `skills`,
     * `subagent`, and `provider` settings. Stored verbatim so the Config tab
     * can edit the full nested shape. Secrets should be expressed as
     * `${ENV_NAME}` placeholders resolved from encrypted runtime secrets.
     */
    extraConfig: v.optional(v.any()),
    /**
     * Ownership marker. `"cli"` means a `filthypanty/` project is the source of
     * truth: the dashboard may still edit it, but those edits are overwritten on
     * the next CLI sync and deleting it from the dashboard is blocked. Unset (or
     * `"dashboard"`) means the dashboard owns it and the CLI never prunes it. The
     * CLI stamps `"cli"` on every sync.
     */
    managedBy: v.optional(v.union(v.literal("cli"), v.literal("dashboard"))),
    updatedAt: v.number(),
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
    environmentId: v.id("environments"),
    nodes: v.array(v.any()),
    edges: v.array(v.any()),
    updatedAt: v.number(),
};

export const agentDeploymentsFields = {
    authId: v.string(),
    agentConfigId: v.id("agentConfigs"),
    status: v.union(v.literal("active"), v.literal("revoked")),
    endpointId: v.string(),
    projectSlug: v.string(),
    environmentSlug: v.string(),
    apiKeyHash: v.optional(v.string()),
    keyHint: v.optional(v.string()),
    updatedAt: v.number(),
};

/**
 * Project + environment scoped CLI/API deploy key. Authorizes the `beeblast`
 * CLI against exactly one project/environment, unlike the org Bearer secret
 * which grants the whole account. Only the SHA-256 hash is stored.
 */
export const deployKeysFields = {
    /** Org account this key resolves to (mirrors the project's org account). */
    accountId: v.id("accounts"),
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    name: v.string(),
    /** SHA-256 hex of the plaintext token; the plaintext is shown once at creation. */
    keyHash: v.string(),
    /** Masked display label (prefix + last four), safe to list without revealing the secret. */
    keyHint: v.string(),
    status: v.union(v.literal("active"), v.literal("revoked")),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/** One-time WorkOS-backed login code minted by the dashboard for CLI login. */
export const cliAuthCodesFields = {
    codeHash: v.string(),
    authId: v.string(),
    orgId: v.id("orgs"),
    accountId: v.id("accounts"),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    createdAt: v.number(),
};

/** Long-lived CLI bearer token created from a one-time WorkOS-backed login code. */
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

/** Lightweight desired-state snapshots for CLI-managed account-service resources. */
export const cliExternalResourcesFields = {
    accountId: v.id("accounts"),
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    kind: v.union(v.literal("skill"), v.literal("tool")),
    name: v.string(),
    description: v.optional(v.string()),
    externalId: v.string(),
    config: v.any(),
    updatedAt: v.number(),
};

export const toolServicesFields = {
    authId: v.string(),
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    nodeId: v.string(),
    nodeLabel: v.string(),
    language: v.union(v.literal("javascript"), v.literal("python")),
    sourceCode: v.string(),
    status: v.union(v.literal("enabled"), v.literal("disabled")),
    updatedAt: v.number(),
};

/** Account-owned custom tool metadata; bundle bytes live in S3. */
export const accountToolsFields = {
    accountId: v.id("accounts"),
    name: v.string(),
    description: v.string(),
    inputSchema: v.any(),
    bundleStorageKey: v.string(),
    sha256: v.string(),
    defaultConfig: v.optional(v.any()),
    status: v.union(v.literal("active"), v.literal("deleted")),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.optional(v.number()),
};

/**
 * Cherry-coke SaaS workspace. Owns the per-tenant filthy-panty `accounts`
 * row; `orgId` on `accounts` points back to one of these.
 */
export const orgsFields = {
    name: v.string(),
    slug: v.string(),
    ownerAuthId: v.string(),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
    createdAt: v.number(),
    /** Set the first time a project is created in this org; gates the home-page auto-onboarding. */
    onboardedAt: v.optional(v.number()),
};

/** Membership join table between users and orgs with role-based access. */
export const orgMembersFields = {
    orgId: v.id("orgs"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    createdAt: v.number(),
};

/** Tenant root for filthy-panty. One row per dashboard org. The doc id IS the accountId. */
export const accountsFields = {
    orgId: v.string(),
    username: v.string(),
    description: v.optional(v.string()),
    secretHash: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/** Agent configuration, stored encrypted so the dashboard cannot read provider secrets. */
export const agentsFields = {
    accountId: v.id("accounts"),
    name: v.string(),
    description: v.optional(v.string()),
    encryptedConfig: v.optional(v.string()),
    encryptionIv: v.optional(v.string()),
    encryptionTag: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/**
 * Account-scoped sandbox config (compute backend + permission mode), referenced
 * by agents via the encrypted agent config. Stored encrypted at rest like agents
 * because `envVars`/`options` may carry provider secrets — filthy-panty (the
 * source of truth for this shared SaaS table) encrypts before writing, so
 * the dashboard only ever persists the opaque blob.
 */
export const sandboxConfigsFields = {
    accountId: v.id("accounts"),
    /**
     * Environment scope. Optional for backward compatibility: legacy rows and
     * rows created through the account-management REST API are account-scoped
     * (env unset) and shared, while CLI- and dashboard-managed rows are scoped
     * to one `(projectId, environmentId)` so the same name can repeat — and stay
     * isolated — across environments. The runtime resolves sandboxes by `_id`,
     * so a per-environment row already yields a per-environment resource.
     */
    projectId: v.optional(v.id("projects")),
    environmentId: v.optional(v.id("environments")),
    name: v.string(),
    description: v.optional(v.string()),
    encryptedConfig: v.optional(v.string()),
    encryptionIv: v.optional(v.string()),
    encryptionTag: v.optional(v.string()),
    /** Ownership marker; see `agentConfigsFields.managedBy`. */
    managedBy: v.optional(v.union(v.literal("cli"), v.literal("dashboard"))),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/**
 * Account-scoped workspace config (persistent S3-backed filesystem), referenced
 * by agents via the encrypted agent config. Holds no secrets, so the config
 * object is stored in plaintext.
 */
export const workspaceConfigsFields = {
    accountId: v.id("accounts"),
    /**
     * Environment scope. Optional for backward compatibility (see
     * `sandboxConfigsFields`). A per-environment row gives the workspace its own
     * `_id`, and the runtime filesystem namespace keys off that `_id`
     * (`accountId:workspaceId`), so two environments never share files.
     */
    projectId: v.optional(v.id("projects")),
    environmentId: v.optional(v.id("environments")),
    name: v.string(),
    description: v.optional(v.string()),
    config: v.any(),
    /** Ownership marker; see `agentConfigsFields.managedBy`. */
    managedBy: v.optional(v.union(v.literal("cli"), v.literal("dashboard"))),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/** CLI-managed runtime variables scoped to a project environment. */
export const environmentVariablesFields = {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    name: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    tag: v.string(),
    updatedAt: v.number(),
};

/** Per-environment outbound webhook endpoint that receives environment events. */
export const webhooksFields = {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    url: v.string(),
    /** HMAC signing secret shared with the receiver to verify payload authenticity. */
    secret: v.string(),
    /** Event names this endpoint subscribes to; an empty array means all events. */
    events: v.array(v.string()),
    active: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/** Conversation thread between an account's caller and one of its agents. */
export const conversationsFields = {
    accountId: v.id("accounts"),
    agentId: v.id("agents"),
    title: v.optional(v.string()),
    createdAt: v.number(),
    lastMessageAt: v.number(),
};

/** Message in a conversation. Role + content + arbitrary metadata. */
export const messagesFields = {
    conversationId: v.id("conversations"),
    accountId: v.id("accounts"),
    role: v.union(
        v.literal("system"),
        v.literal("user"),
        v.literal("assistant"),
        v.literal("tool"),
    ),
    content: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
};

/** Skill metadata; binary content lives in S3 under accountId-prefixed keys. */
export const skillsFields = {
    accountId: v.id("accounts"),
    name: v.string(),
    description: v.optional(v.string()),
    s3Key: v.string(),
    sizeBytes: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/**
 * File/folder entries stored inside a workspace canvas node.
 * Binary content lives in Convex storage; this table tracks metadata and the tree.
 */
export const workspaceFilesFields = {
    authId: v.string(),
    projectId: v.id("projects"),
    nodeId: v.string(),
    /** Full path from the workspace root, e.g. "src/components/Button.tsx". */
    path: v.string(),
    /** Filename or folder name, e.g. "Button.tsx". */
    name: v.string(),
    isFolder: v.boolean(),
    storageId: v.optional(v.id("_storage")),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/** Async job tracking for the harness-processing /async endpoint. */
export const asyncResultsFields = {
    accountId: v.id("accounts"),
    eventId: v.string(),
    status: v.union(
        v.literal("pending"),
        v.literal("running"),
        v.literal("completed"),
        v.literal("failed"),
    ),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/**
 * Per-account scheduled agent runs. Mirrors filthy-panty's CronJobRecord
 * (functions/_shared/cron-jobs.ts) so the SaaS dashboard can manage them
 * directly via Convex live queries. The schedulerName / schedulerGroupName
 * are still the AWS EventBridge Scheduler identifiers — Convex stores them
 * for visibility but filthy-panty Lambda is what actually invokes EBS.
 */
export const cronJobsFields = {
    accountId: v.id("accounts"),
    name: v.string(),
    description: v.optional(v.string()),
    agentId: v.id("agents"),
    prompt: v.string(),
    conversationKey: v.optional(v.string()),
    scheduleExpression: v.string(),
    timezone: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("paused")),
    schedulerName: v.string(),
    schedulerGroupName: v.string(),
    lastInvokedAt: v.optional(v.number()),
    lastStatus: v.optional(
        v.union(
            v.literal("started"),
            v.literal("completed"),
            v.literal("failed"),
        ),
    ),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
};

export default defineSchema({
    users: defineTable(usersFields)
        .index("by_authId", ["authId"])
        .index("by_accountHandle", ["accountHandle"]),
    projects: defineTable(projectsFields)
        .index("by_authId", ["authId"])
        .index("by_authId_and_slug", ["authId", "slug"])
        .index("by_orgId", ["orgId"]),
    environments: defineTable(environmentsFields)
        .index("by_projectId", ["projectId"])
        .index("by_authId_and_projectId", ["authId", "projectId"]),
    agentConfigs: defineTable(agentConfigsFields)
        .index("by_authId", ["authId"])
        .index("by_projectId_and_environmentId", ["projectId", "environmentId"])
        .index("by_agentId", ["agentId"]),
    agentRuntimeSecrets: defineTable(agentRuntimeSecretsFields)
        .index("by_agentConfigId", ["agentConfigId"]),
    canvasLayouts: defineTable(canvasLayoutsFields)
        .index("by_projectId_and_environmentId", ["projectId", "environmentId"]),
    agentDeployments: defineTable(agentDeploymentsFields)
        .index("by_agentConfigId", ["agentConfigId"])
        .index("by_authId", ["authId"]),
    toolServices: defineTable(toolServicesFields)
        .index("by_projectId_environmentId_and_nodeId", [
            "projectId",
            "environmentId",
            "nodeId",
        ]),
    deployKeys: defineTable(deployKeysFields)
        .index("by_keyHash", ["keyHash"])
        .index("by_projectId_and_environmentId", ["projectId", "environmentId"]),
    cliAuthCodes: defineTable(cliAuthCodesFields)
        .index("by_codeHash", ["codeHash"])
        .index("by_accountId", ["accountId"]),
    cliTokens: defineTable(cliTokensFields)
        .index("by_tokenHash", ["tokenHash"])
        .index("by_accountId", ["accountId"])
        .index("by_authId", ["authId"]),
    cliExternalResources: defineTable(cliExternalResourcesFields)
        .index("by_projectId_and_environmentId", ["projectId", "environmentId"])
        .index("by_environmentId_kind_and_name", ["environmentId", "kind", "name"])
        .index("by_accountId", ["accountId"]),
    orgs: defineTable(orgsFields)
        .index("by_slug", ["slug"])
        .index("by_ownerAuthId", ["ownerAuthId"]),
    orgMembers: defineTable(orgMembersFields)
        .index("by_orgId", ["orgId"])
        .index("by_userId", ["userId"])
        .index("by_orgId_and_userId", ["orgId", "userId"]),
    accounts: defineTable(accountsFields)
        .index("by_orgId", ["orgId"])
        .index("by_secretHash", ["secretHash"]),
    agents: defineTable(agentsFields).index("by_accountId", ["accountId"]),
    accountTools: defineTable(accountToolsFields)
        .index("by_accountId", ["accountId"])
        .index("by_accountId_and_status", ["accountId", "status"]),
    sandboxConfigs: defineTable(sandboxConfigsFields)
        .index("by_accountId", ["accountId"])
        .index("by_accountId_and_name", ["accountId", "name"])
        .index("by_environmentId_and_name", ["environmentId", "name"]),
    workspaceConfigs: defineTable(workspaceConfigsFields)
        .index("by_accountId", ["accountId"])
        .index("by_accountId_and_name", ["accountId", "name"])
        .index("by_environmentId_and_name", ["environmentId", "name"]),
    environmentVariables: defineTable(environmentVariablesFields)
        .index("by_projectId_and_environmentId", ["projectId", "environmentId"])
        .index("by_environmentId_and_name", ["environmentId", "name"]),
    webhooks: defineTable(webhooksFields)
        .index("by_projectId_and_environmentId", ["projectId", "environmentId"]),
    conversations: defineTable(conversationsFields)
        .index("by_accountId", ["accountId"])
        .index("by_accountId_and_agentId", ["accountId", "agentId"]),
    messages: defineTable(messagesFields)
        .index("by_conversationId", ["conversationId"])
        .index("by_accountId", ["accountId"]),
    skills: defineTable(skillsFields).index("by_accountId", ["accountId"]),
    workspaceFiles: defineTable(workspaceFilesFields)
        .index("by_projectId_and_nodeId", ["projectId", "nodeId"])
        .index("by_projectId_nodeId_and_path", ["projectId", "nodeId", "path"])
        .index("by_authId", ["authId"]),
    asyncResults: defineTable(asyncResultsFields)
        .index("by_accountId", ["accountId"])
        .index("by_eventId", ["eventId"]),
    cronJobs: defineTable(cronJobsFields)
        .index("by_accountId", ["accountId"])
        .index("by_accountId_and_agentId", ["accountId", "agentId"])
        .index("by_accountId_and_status", ["accountId", "status"])
        .index("by_schedulerName", ["schedulerName"]),
});
