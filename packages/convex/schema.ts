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
    /** Semantic environment role. Optional for legacy rows created before roles existed. */
    kind: v.optional(v.union(v.literal("development"), v.literal("production"), v.literal("custom"))),
    /** Lambda deploy region for promoted/deployable environments. */
    deploymentRegion: v.optional(
        v.union(v.literal("ap-southeast-1"), v.literal("eu-west-1"), v.literal("us-east-1")),
    ),
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
    memoryToolEnabled: v.optional(v.boolean()),
    searchToolEnabled: v.optional(v.boolean()),
    searchToolConfig: v.optional(v.any()),
    runtimeVariables: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
    /**
     * Broods AgentConfig branches that don't live as flat columns:
     * `agent`, `workspace`, `session`, `hooks`, `channels`, `tools`, `skills`,
     * `subagent`, and `provider` settings. Stored verbatim so the Config tab
     * can edit the full nested shape. Secrets should be expressed as
     * `${ENV_NAME}` placeholders resolved from encrypted runtime secrets.
     */
    extraConfig: v.optional(v.any()),
    /**
     * Ownership marker. `"cli"` means a `broods/` project is the source of
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

/**
 * Project + environment scoped runtime API key (`fp_agent_…`). One key per
 * environment invokes ANY deployed agent in it; the agent is selected per request
 * by id. The SHA-256 hash authenticates runtime calls; the plaintext is also kept
 * AES-GCM encrypted at rest so the owner can recover it for dashboard streaming
 * and CLI reconnect without rotating.
 */
export const agentDeploymentsFields = {
    authId: v.string(),
    accountId: v.id("accounts"),
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    status: v.union(v.literal("active"), v.literal("revoked")),
    endpointId: v.string(),
    projectSlug: v.string(),
    environmentSlug: v.string(),
    apiKeyHash: v.string(),
    keyHint: v.string(),
    // AES-GCM blob of the plaintext key (owner-recoverable without rotating).
    apiKeyCiphertext: v.string(),
    apiKeyIv: v.string(),
    apiKeyTag: v.string(),
    updatedAt: v.number(),
};

/**
 * Project + environment scoped CLI/API deploy key. Authorizes the `broods`
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
 * Cherry-coke SaaS workspace. Owns the per-tenant broods `accounts`
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

/** Tenant root for broods. One row per dashboard org. The doc id IS the accountId. */
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
 * because `envVars`/`options` may carry provider secrets — broods (the
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
    /**
     * Unresolved config blob retaining `${ENV_NAME}` placeholders (the form
     * before env vars are substituted into `encryptedConfig`). Kept so a later
     * `environmentVariables.set` can re-resolve and re-push `encryptedConfig`
     * without a CLI re-sync — the sandbox equivalent of how `agentConfigs` keeps
     * its flat columns as the placeholder source. Absent on legacy rows.
     */
    encryptedSourceConfig: v.optional(v.string()),
    sourceEncryptionIv: v.optional(v.string()),
    sourceEncryptionTag: v.optional(v.string()),
    /** Masked markers of the `env.NAME` refs this config uses; see `agentConfigsFields.runtimeVariables`. */
    runtimeVariables: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
    /** Prebuilt snapshot/image id this sandbox launches from, when pinned (see `sandboxSnapshotsFields`). */
    snapshotId: v.optional(v.string()),
    /** Ownership marker; see `agentConfigsFields.managedBy`. */
    managedBy: v.optional(v.union(v.literal("cli"), v.literal("dashboard"))),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/** Sandbox compute backends a persistent instance / snapshot can target. */
export const sandboxProviderValidator = v.union(
    v.literal("sandbox"),
    v.literal("lambda"),
    v.literal("daytona"),
    v.literal("e2b"),
    v.literal("vercel"),
);

/**
 * Live persistent-sandbox registry, mirrored from broods so the dashboard can
 * show running/suspended instances and drive suspend/resume/terminate through
 * Convex live queries. broods (the runtime) is authoritative — it owns the
 * provider lifecycle and the DynamoDB reconnection map, and dual-writes each
 * transition here; this table is the real-time view, not the source of truth.
 * One row per reserved sandbox, keyed by `reservationKey` (the broods
 * reconnection key, globally unique since it embeds the account + workspace).
 */
export const sandboxInstancesFields = {
    accountId: v.id("accounts"),
    /** Environment scope; optional like `sandboxConfigsFields` for account-scoped/legacy rows. */
    projectId: v.optional(v.id("projects")),
    environmentId: v.optional(v.id("environments")),
    provider: sandboxProviderValidator,
    /** Stable reservation key broods reconnects by (mirror of the DynamoDB instanceKey). */
    reservationKey: v.string(),
    /** Sandbox config this instance was reserved from; lets the dashboard drive its write-path. */
    sandboxConfigId: v.optional(v.id("sandboxConfigs")),
    /** Provider-side id: workdir `sbx_…` / MicroVM `microvmId` / daytona id / vercel name. */
    externalId: v.string(),
    name: v.string(),
    status: v.union(
        v.literal("running"),
        v.literal("suspended"),
        v.literal("terminating"),
        v.literal("error"),
    ),
    /** Snapshot/image this instance launched from, when any. */
    snapshotId: v.optional(v.string()),
    /** Non-secret egress policy summary (config `network.mode`); powers the dashboard Networking view. */
    egress: v.optional(
        v.union(v.literal("allow-all"), v.literal("deny-all"), v.literal("restricted")),
    ),
    /** Tool approval policy (`edit`/`ask`/`bypass`); powers the dashboard Security view. */
    permissionMode: v.optional(
        v.union(v.literal("edit"), v.literal("ask"), v.literal("bypass")),
    ),
    specs: v.object({ vcpu: v.number(), memoryMb: v.number(), storageGb: v.number() }),
    createdAt: v.number(),
    lastUsedAt: v.number(),
    suspendedAt: v.optional(v.number()),
    terminatedAt: v.optional(v.number()),
};

/**
 * Sandbox snapshot/image registry, mirrored from broods. Account-scoped because
 * a built image is reusable across environments. `status` follows the unified
 * (Daytona-aligned) build model mapped from AWS MicroVM image versions and
 * workdir images; broods owns the build pipeline and dual-writes status here.
 */
export const sandboxSnapshotsFields = {
    accountId: v.id("accounts"),
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
    /** Provider-side image id: workdir image id / MicroVM image ARN. */
    externalImageId: v.string(),
    pulledCount: v.number(),
    createdAt: v.number(),
    lastUsedAt: v.number(),
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

/**
 * Audit record written every time an environment variable's plaintext value is
 * revealed (via the dashboard eye-icon or the CLI `env get`), so reveals of
 * otherwise write-only secrets leave a trail of who read what and when.
 */
export const environmentVariableRevealsFields = {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    environmentVariableId: v.id("environmentVariables"),
    name: v.string(),
    source: v.union(v.literal("dashboard"), v.literal("cli")),
    /** WorkOS authId of the dashboard user who revealed it (when source is "dashboard"). */
    revealedByAuthId: v.optional(v.string()),
    /** Account that revealed it through a CLI deploy token (when source is "cli"). */
    revealedByAccountId: v.optional(v.id("accounts")),
    /** CLI token row used for the reveal, when authenticated by `broods login`. */
    revealedByCliTokenId: v.optional(v.id("cliTokens")),
    /** WorkOS authId attached to the CLI token used for the reveal. */
    revealedByCliAuthId: v.optional(v.string()),
    /** Project/environment deploy key used for the reveal, when authenticated by a deploy key. */
    revealedByDeployKeyId: v.optional(v.id("deployKeys")),
    revealedAt: v.number(),
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
    role: v.union(v.literal("system"), v.literal("user"), v.literal("assistant"), v.literal("tool")),
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
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed")),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/**
 * Per-account scheduled agent runs. Mirrors broods's CronRecord
 * (functions/_shared/cron.ts) so the SaaS dashboard can manage them
 * directly via Convex live queries. The schedulerName / schedulerGroupName
 * are still the AWS EventBridge Scheduler identifiers — Convex stores them
 * for visibility but broods Lambda is what actually invokes EBS.
 */
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
    schedulerName: v.string(),
    schedulerGroupName: v.string(),
    lastInvokedAt: v.optional(v.number()),
    lastStatus: v.optional(v.union(v.literal("started"), v.literal("completed"), v.literal("failed"))),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
};

export const cronRunsFields = {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    eventId: v.string(),
    conversationKey: v.string(),
    status: v.union(v.literal("started"), v.literal("completed"), v.literal("failed")),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
};

/**
 * Per-finished-task usage row. Written once per agent task at completion, giving
 * the dashboard a line-item token/compute cost per task. Indexes allow scoping to
 * a specific deployment (`endpointId`) or to the whole account. Pricing is
 * computed at render from a hardcoded shared pricing table — only raw counts are
 * stored here.
 */
export const usageTasksFields = {
    accountId: v.id("accounts"),
    /** Per-deployment id (matches agentDeployments.endpointId); the dashboard join key. */
    endpointId: v.string(),
    agentId: v.string(),
    conversationKey: v.string(),
    /** Unique task id (= session.eventId) for idempotency. */
    taskId: v.string(),
    modelProvider: v.string(),
    modelId: v.string(),
    /** Epoch ms when the task finished. */
    finishedAt: v.number(),
    /** Wall-clock duration of the task in ms. */
    durationMs: v.number(),
    status: v.union(v.literal("completed"), v.literal("failed")),
    // Token counts — raw only; price computed in the UI.
    inputTokens: v.number(),
    outputTokens: v.number(),
    reasoningTokens: v.number(),
    /** Cache-read tokens (cached input). */
    cachedInputTokens: v.number(),
    /** Cache-write tokens (cache creation). */
    cacheWriteTokens: v.number(),
    totalTokens: v.number(),
    /** Harness runtime backend (currently always "lambda"). */
    runtimeKind: v.string(),
    /** Harness runtime wall-clock ms (GB-seconds proxy when multiplied by memory). */
    runtimeWallMs: v.number(),
    /** Harness runtime memory size in MB (from AWS_LAMBDA_FUNCTION_MEMORY_SIZE). */
    runtimeMemoryMb: v.number(),
    /**
     * CPU consumed in sandboxes during the task, one entry per sandbox context:
     * the agent's own sandbox (role "agent") and any per-tool sandbox (role
     * "tool"), tagged by provider `type` ("sandbox", "lambda", …). cpuUsec is
     * recorded for the self-hosted providers (sandbox via the workdir exec report,
     * lambda via the MicroVM image's getrusage report); others store 0.
     */
    sandboxUsage: v.array(
        v.object({
            type: v.string(),
            role: v.union(v.literal("agent"), v.literal("tool")),
            toolName: v.optional(v.string()),
            cpuUsec: v.number(),
        }),
    ),
    /** Number of model steps (model.step.finished events). */
    stepCount: v.number(),
    /** Number of tool calls across all steps. */
    toolCallCount: v.number(),
};

/**
 * Pre-aggregated token usage per (deployment, time bucket, model), upserted by
 * the harness so the dashboard usage panel streams live without scanning logs.
 * Stored at a fixed 5-minute base bin; queries re-group it into the requested
 * range. Buckets are sparse (only active windows exist), so row count tracks
 * real activity, not wall-clock time.
 */
export const usageRollupsFields = {
    accountId: v.id("accounts"),
    endpointId: v.string(),
    /** Epoch ms floored to the 5-minute base bin. */
    bucketStart: v.number(),
    modelProvider: v.string(),
    modelId: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    reasoningTokens: v.number(),
    cachedInputTokens: v.number(),
    /** Cache-write tokens (cache creation) folded into this bucket. */
    cacheWriteTokens: v.number(),
    totalTokens: v.number(),
    /** Count of model.invocation.finished (agent tasks) in this bucket. */
    invocations: v.number(),
    /** Count of model.step.finished (individual model calls) in this bucket. */
    modelCalls: v.number(),
    /** Harness runtime wall-clock ms folded into this bucket. */
    runtimeWallMs: v.number(),
    /** Sandbox CPU usage_usec folded into this bucket. */
    agentSandboxCpuUsec: v.number(),
    /** Tool-sandbox CPU usage_usec (user-uploaded tools) folded into this bucket. */
    toolSandboxCpuUsec: v.number(),
    updatedAt: v.number(),
};

export default defineSchema({
    users: defineTable(usersFields).index("by_authId", ["authId"]).index("by_accountHandle", ["accountHandle"]),
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
    agentRuntimeSecrets: defineTable(agentRuntimeSecretsFields).index("by_agentConfigId", ["agentConfigId"]),
    canvasLayouts: defineTable(canvasLayoutsFields).index("by_projectId_and_environmentId", [
        "projectId",
        "environmentId",
    ]),
    agentDeployments: defineTable(agentDeploymentsFields)
        .index("by_projectId_and_environmentId", ["projectId", "environmentId"])
        .index("by_projectId_and_environmentId_and_status", ["projectId", "environmentId", "status"])
        .index("by_apiKeyHash", ["apiKeyHash"])
        .index("by_authId", ["authId"]),
    toolServices: defineTable(toolServicesFields).index("by_projectId_environmentId_and_nodeId", [
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
    orgs: defineTable(orgsFields).index("by_slug", ["slug"]).index("by_ownerAuthId", ["ownerAuthId"]),
    orgMembers: defineTable(orgMembersFields)
        .index("by_orgId", ["orgId"])
        .index("by_userId", ["userId"])
        .index("by_orgId_and_userId", ["orgId", "userId"]),
    accounts: defineTable(accountsFields).index("by_orgId", ["orgId"]).index("by_secretHash", ["secretHash"]),
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
    sandboxInstances: defineTable(sandboxInstancesFields)
        .index("by_accountId", ["accountId"])
        .index("by_accountId_projectId_and_environmentId", ["accountId", "projectId", "environmentId"])
        .index("by_reservationKey", ["reservationKey"]),
    sandboxSnapshots: defineTable(sandboxSnapshotsFields)
        .index("by_accountId", ["accountId"])
        .index("by_accountId_and_name", ["accountId", "name"]),
    environmentVariables: defineTable(environmentVariablesFields)
        .index("by_projectId_and_environmentId", ["projectId", "environmentId"])
        .index("by_environmentId_and_name", ["environmentId", "name"]),
    environmentVariableReveals: defineTable(environmentVariableRevealsFields)
        .index("by_environmentId", ["environmentId"])
        .index("by_environmentVariableId", ["environmentVariableId"]),
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
    asyncResults: defineTable(asyncResultsFields).index("by_accountId", ["accountId"]).index("by_eventId", ["eventId"]),
    crons: defineTable(cronsFields)
        .index("by_accountId", ["accountId"])
        .index("by_accountId_and_agentId", ["accountId", "agentId"])
        .index("by_accountId_and_status", ["accountId", "status"])
        .index("by_schedulerName", ["schedulerName"]),
    cronRuns: defineTable(cronRunsFields).index("by_accountId_and_cronId_and_startedAt", [
        "accountId",
        "cronId",
        "startedAt",
    ]),
    usageTasks: defineTable(usageTasksFields)
        .index("by_endpointId_and_finishedAt", ["endpointId", "finishedAt"])
        .index("by_accountId_and_finishedAt", ["accountId", "finishedAt"])
        .index("by_accountId_and_taskId", ["accountId", "taskId"]),
    usageRollups: defineTable(usageRollupsFields)
        .index("by_endpointId_and_bucketStart", ["endpointId", "bucketStart"])
        .index("by_accountId_endpointId_bucketStart_modelProvider_modelId", [
            "accountId",
            "endpointId",
            "bucketStart",
            "modelProvider",
            "modelId",
        ]),
});
