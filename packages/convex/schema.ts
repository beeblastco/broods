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
  /** Set when a WorkOS deletion webhook has queued irreversible teardown. */
  workosDeletionRequestedAt: v.optional(v.number()),
  /** Number of runtime-cleanup retries after a WorkOS deletion webhook. */
  workosDeletionAttempts: v.optional(v.number()),
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

export const stagesFields = {
  authId: v.string(),
  projectId: v.id("projects"),
  name: v.string(),
  /** Semantic stage role. Optional for legacy rows created before roles existed. */
  kind: v.optional(
    v.union(
      v.literal("development"),
      v.literal("production"),
      v.literal("custom"),
    ),
  ),
  /** Lambda deploy region for promoted/deployable stages. */
  deploymentRegion: v.optional(
    v.union(
      v.literal("ap-southeast-1"),
      v.literal("eu-west-1"),
      v.literal("us-east-1"),
    ),
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
   * the next CLI sync and deleting it from the dashboard is blocked. `"api"`
   * means the account REST API owns it — its config is re-mirrored onto the
   * canvas on every API write and dashboard edits are locked. Unset (or
   * `"dashboard"`) means the dashboard owns it and neither sync prunes it.
   */
  managedBy: v.optional(
    v.union(v.literal("cli"), v.literal("dashboard"), v.literal("api")),
  ),
  updatedAt: v.number(),
};

/**
 * Projection of deployed channel connections, one row per (agent, channel,
 * deployment) that configures a bot token. `model/channelEndpoints.ts` is the
 * single writer; the forwarder's standing `listConnections` subscription reads
 * this instead of every deployment and agent blob. The token is AES-GCM
 * encrypted with the account-config secret, and `digest` is a content hash so
 * an unchanged row is never rewritten (a fresh IV would dirty the
 * subscription on every refresh).
 */
export const channelEndpointsFields = {
  accountId: v.id("accounts"),
  agentId: v.string(),
  agentName: v.string(),
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
  nodes: v.array(v.any()),
  edges: v.array(v.any()),
  updatedAt: v.number(),
};

/**
 * Project + stage scoped runtime API key (`fp_agent_…`). One key per
 * stage invokes ANY deployed agent in it; the agent is selected per request
 * by id. The SHA-256 hash authenticates runtime calls; the plaintext is also kept
 * AES-GCM encrypted at rest so the owner can recover it for dashboard streaming
 * and CLI reconnect without rotating.
 */
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
  // AES-GCM blob of the plaintext key (owner-recoverable without rotating).
  apiKeyCiphertext: v.string(),
  apiKeyIv: v.string(),
  apiKeyTag: v.string(),
  updatedAt: v.number(),
};

/**
 * Project + stage scoped CLI/API deploy key. Authorizes the `broods`
 * CLI against exactly one project/stage, unlike the org Bearer secret
 * which grants the whole account. Only the SHA-256 hash is stored.
 */
export const deployKeysFields = {
  /** Org account this key resolves to (mirrors the project's org account). */
  accountId: v.id("accounts"),
  projectId: v.id("projects"),
  stageId: v.id("stages"),
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
  stageId: v.id("stages"),
  kind: v.union(
    v.literal("skill"),
    // Retired (#331 phase 3): stored rows only; migrations:sunsetCustomTools
    // deletes them, then the literal can go.
    v.literal("tool"),
    v.literal("hook"),
    v.literal("mcp"),
  ),
  name: v.string(),
  description: v.optional(v.string()),
  externalId: v.string(),
  config: v.any(),
  updatedAt: v.number(),
};

/**
 * Registered external MCP server (issue #331 phase 1). Core connects over the
 * stateless HTTP transport, spec 2026-07-28 only. Rows are stage-scoped from
 * day one; header values may be ${NAME} env refs resolved into the encrypted
 * agent config at sync time, so secrets never sit on this row.
 */
export const mcpFields = {
  accountId: v.id("accounts"),
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  /** Namespace prefix for the server's tools (`name__tool`); unique per stage. */
  name: v.string(),
  description: v.optional(v.string()),
  /** "http" connects to an external url; "hosted" runs an uploaded bundle on the Lambda host. */
  transport: v.union(v.literal("http"), v.literal("hosted")),
  /** Required for "http"; absent on "hosted" rows (the Lambda is the endpoint). */
  url: v.optional(v.string()),
  /** Hosted-only: S3 key + sha256 of the uploaded server bundle. */
  bundleStorageKey: v.optional(v.string()),
  sha256: v.optional(v.string()),
  headers: v.optional(v.record(v.string(), v.string())),
  /** Tool names the harness may register from this server; absent means all. */
  allowedTools: v.optional(v.array(v.string())),
  /** Dashboard enable/disable toggle. `status` is lifecycle, this is intent. */
  disabled: v.optional(v.boolean()),
  /** Canvas node that owns this row when it was authored on the dashboard. */
  nodeId: v.optional(v.string()),
  /** Dashboard-authored server source, kept for the editor; CLI rows omit it. */
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

/** Account-owned code hook metadata; bundle bytes live in the tool bundles S3 bucket. */
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

/** Stage-scoped reusable agent authorization policy. */
export const agentPoliciesFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  name: v.string(),
  description: v.optional(v.string()),
  document: v.any(),
  status: v.union(v.literal("active"), v.literal("deleted")),
  /** Ownership marker; see `agentConfigsFields.managedBy`. */
  managedBy: v.optional(
    v.union(v.literal("cli"), v.literal("dashboard"), v.literal("api")),
  ),
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt: v.optional(v.number()),
};

/**
 * Scoped API role assumed via `POST /v1/account/assume-role`. The policy is a
 * version-1 PolicyDocument over the `<resource>:read`/`<resource>:write` API
 * action namespace (model/roleRules.ts validates it). `projectId`/`stageId`
 * bound which stage runtime keys may assume the role, same shape as deployKeys.
 */
export const accountRolesFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  /** Public role id: "fp_role_" + random. */
  roleId: v.string(),
  name: v.string(),
  status: v.union(v.literal("active"), v.literal("disabled")),
  /** PolicyDocument (version 1) over the API action namespace. */
  policy: v.any(),
  createdAt: v.number(),
  updatedAt: v.number(),
};

/**
 * Short-lived assume-role session backing an `fp_sts_` bearer token. Only the
 * SHA-256 hash is stored, same pattern as cliTokens. Rows die by `expiresAt`;
 * revocation is disabling or deleting the role.
 */
export const roleSessionsFields = {
  tokenHash: v.string(),
  roleId: v.string(),
  accountId: v.id("accounts"),
  expiresAt: v.number(),
  createdAt: v.number(),
};

/**
 * One row per real place a team talks — a Slack channel, a Discord channel, a
 * repository. Binds that place to an agent and carries the instructions,
 * workspaces, policies and roles scoped to it. `config.channels` on an agent
 * still holds the adapter credentials; this row decides who answers where.
 */
export const channelRecordsFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  /** Adapter name: slack, discord, telegram, github, pancake, zalo. */
  platform: v.string(),
  /** Provider id of the place, e.g. a Slack channel id or an owner/repo. */
  externalId: v.string(),
  /** Team or guild the place sits in, when the provider has one. */
  workspaceRef: v.optional(v.string()),
  name: v.string(),
  description: v.optional(v.string()),
  /** Plaintext: bindings, instructions, policy and workspace ids — no secrets. */
  config: v.any(),
  status: v.union(v.literal("active"), v.literal("deleted")),
  /** Ownership marker; see `agentConfigsFields.managedBy`. */
  managedBy: v.optional(
    v.union(v.literal("cli"), v.literal("dashboard"), v.literal("api")),
  ),
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
  /**
   * Unresolved account-plane config retaining `${NAME}` placeholders (the
   * form before account env vars are substituted into `encryptedConfig`).
   * Kept so an account env-var change can re-resolve `encryptedConfig`
   * without the client re-syncing this agent. Absent on legacy rows.
   */
  encryptedSourceConfig: v.optional(v.string()),
  sourceEncryptionIv: v.optional(v.string()),
  sourceEncryptionTag: v.optional(v.string()),
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
   * Stage scope. Optional for backward compatibility: legacy rows and
   * rows created through the account-management REST API are account-scoped
   * (stage unset) and shared, while CLI- and dashboard-managed rows are scoped
   * to one `(projectId, stageId)` so the same name can repeat — and stay
   * isolated — across stages. The runtime resolves sandboxes by `_id`, so a
   * per-stage row already yields a per-stage resource.
   */
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
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
  /** Masked markers of the `env("NAME")` refs this config uses; see `agentConfigsFields.runtimeVariables`. */
  runtimeVariables: v.optional(
    v.array(v.object({ key: v.string(), value: v.string() })),
  ),
  /** Prebuilt snapshot/image id this sandbox launches from, when pinned (see `sandboxSnapshotsFields`). */
  snapshotId: v.optional(v.string()),
  /** Ownership marker; see `agentConfigsFields.managedBy`. */
  managedBy: v.optional(
    v.union(v.literal("cli"), v.literal("dashboard"), v.literal("api")),
  ),
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
 * provider lifecycle and writes each transition here. Reservation reconnects
 * use the authoritative `sandboxReservations` table.
 * One row per reserved sandbox, keyed by `reservationKey` (the broods
 * reconnection key, globally unique since it embeds the account + workspace).
 */
export const sandboxInstancesFields = {
  accountId: v.id("accounts"),
  /** Stage scope; optional like `sandboxConfigsFields` for account-scoped/legacy rows. */
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  provider: sandboxProviderValidator,
  /** Stable reservation key used by broods reconnects. */
  reservationKey: v.string(),
  /** Sandbox config this instance was reserved from; lets the dashboard drive its write-path. */
  sandboxConfigId: v.optional(v.id("sandboxConfigs")),
  /** Provider-side id: workdir `sbx_…` / MicroVM `microvmId` / daytona id / vercel name. */
  externalId: v.string(),
  name: v.string(),
  /**
   * `suspending` is the dashboard-owned transition: the suspend action parks the row
   * there while broods frees the provider compute, so the UI can lock the toggle until
   * a terminal state lands. broods only ever writes the terminal states.
   */
  status: v.union(
    v.literal("running"),
    v.literal("suspending"),
    v.literal("suspended"),
    v.literal("terminating"),
    v.literal("error"),
  ),
  /** Snapshot/image this instance launched from, when any. */
  snapshotId: v.optional(v.string()),
  /** Non-secret egress policy summary (config `network.mode`); powers the dashboard Networking view. */
  egress: v.optional(
    v.union(
      v.literal("allow-all"),
      v.literal("deny-all"),
      v.literal("restricted"),
    ),
  ),
  /** Tool approval policy (`edit`/`ask`/`bypass`); powers the dashboard Security view. */
  permissionMode: v.optional(
    v.union(v.literal("edit"), v.literal("ask"), v.literal("bypass")),
  ),
  specs: v.object({
    vcpu: v.number(),
    memoryMb: v.number(),
    storageGb: v.number(),
  }),
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
  terminatedAt: v.optional(v.number()),
  /**
   * Set for a create-and-destroy instance that only exists for the length of one
   * call (its `reservationKey` is the provider id, not a reconnect key). It is shown
   * so live compute is visible, but nothing can suspend/resume/terminate it — broods
   * drops the row itself when the call ends.
   */
  ephemeral: v.optional(v.boolean()),
};

/**
 * Sandbox snapshot/image registry, mirrored from broods. Account-scoped because
 * a built image is reusable across stages. `status` follows the unified
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

/** Sandbox lifecycle action names recorded in the operator audit trail. */
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

/**
 * Operator audit trail for sandbox lifecycle actions. Stores metadata only:
 * never command text, provider secrets, or terminal credentials.
 */
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

/**
 * Account-scoped workspace config (persistent S3-backed filesystem), referenced
 * by agents via the encrypted agent config. Holds no secrets, so the config
 * object is stored in plaintext.
 */
export const workspaceConfigsFields = {
  accountId: v.id("accounts"),
  /**
   * Stage scope. Optional for backward compatibility (see
   * `sandboxConfigsFields`). A per-stage row gives the workspace its own
   * `_id`, and the runtime filesystem namespace keys off that `_id`
   * (`accountId:workspaceId`), so two stages never share files.
   */
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  name: v.string(),
  description: v.optional(v.string()),
  config: v.any(),
  /** Ownership marker; see `agentConfigsFields.managedBy`. */
  managedBy: v.optional(
    v.union(v.literal("cli"), v.literal("dashboard"), v.literal("api")),
  ),
  createdAt: v.number(),
  updatedAt: v.number(),
};

/** CLI-managed runtime variables scoped to a project stage. */
export const environmentVariablesFields = {
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  name: v.string(),
  ciphertext: v.string(),
  iv: v.string(),
  tag: v.string(),
  /** SHA-256 hex of the plaintext value; absent on rows written before this field. */
  valueDigest: v.optional(v.string()),
  updatedAt: v.number(),
};

/** Account-scoped runtime variables for the public config plane; values are write-only through the API. */
export const accountEnvVarsFields = {
  accountId: v.id("accounts"),
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
  stageId: v.id("stages"),
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
  /** Project/stage deploy key used for the reveal, when authenticated by a deploy key. */
  revealedByDeployKeyId: v.optional(v.id("deployKeys")),
  revealedAt: v.number(),
};

/** Actor metadata for account-visible configuration audit events. */
export const configAuditActorKindValidator = v.union(
  v.literal("dashboardUser"),
  v.literal("apiAccountSecret"),
  v.literal("admin"),
  v.literal("service"),
  v.literal("cli"),
  v.literal("deployKey"),
  v.literal("role"),
);

/** Resource types recorded in the account-visible configuration audit feed. */
export const configAuditResourceKindValidator = v.union(
  v.literal("account"),
  v.literal("agent"),
  v.literal("skill"),
  // Retired kind (#331 phase 3), kept so historical audit rows stay valid.
  v.literal("tool"),
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
  v.literal("unknown"),
);

/**
 * Account-visible audit feed for configuration mutations. Details are capped
 * before insert and must never carry plaintext secrets or config blobs.
 */
export const configAuditEventsFields = {
  accountId: v.id("accounts"),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  actor: v.object({
    kind: configAuditActorKindValidator,
    id: v.optional(v.string()),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
  }),
  action: v.string(),
  resource: v.object({
    kind: configAuditResourceKindValidator,
    id: v.optional(v.string()),
    name: v.optional(v.string()),
  }),
  summary: v.string(),
  detailsJson: v.optional(v.string()),
};

/** Failed-auth counters for config HTTP routes. */
export const configHttpAuthFailuresFields = {
  key: v.string(),
  windowStart: v.number(),
  count: v.number(),
  blockedUntil: v.optional(v.number()),
  updatedAt: v.number(),
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

/**
 * Capability link for one file in a workspace's S3 namespace, redeemed with no
 * credential of its own. It exists because a presigned S3 URL cannot survive the
 * trip: 1.4 KB of it is an STS token whose `+` characters chat clients mangle.
 */
export const workspaceDownloadTokensFields = {
  accountId: v.id("accounts"),
  workspaceId: v.id("workspaceConfigs"),
  /** Workspace-relative path, already normalized when the token was minted. */
  path: v.string(),
  /** Name offered to whoever follows the link. */
  filename: v.string(),
  /** SHA-256 hex of the token; the token itself only ever exists in the URL. */
  tokenHash: v.string(),
  expiresAt: v.number(),
  createdAt: v.number(),
};

/** Ordered AI SDK events for one runtime conversation. */
export const runtimeConversationEventsFields = {
  accountId: v.string(),
  conversationKey: v.string(),
  cursor: v.string(),
  event: v.any(),
};
/** Resumable checkpoint for one AI SDK Harness conversation. */
export const runtimeHarnessSessionsFields = {
  accountId: v.string(),
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
  updatedAt: v.number(),
};
/** Context-only webhook event dedupe claims. */
export const runtimeClaimsFields = {
  accountId: v.optional(v.string()),
  key: v.string(),
  kind: v.literal("event"),
  expiresAt: v.number(),
};
/** Public concurrency policy selected for one ingress request. */
export const ingressModeValidator = v.union(
  v.literal("reject"),
  v.literal("followup"),
  v.literal("collect"),
  v.literal("steer"),
);
/** Mode actually applied after the coordinator reaches a runnable boundary. */
export const appliedIngressModeValidator = v.union(
  v.literal("reject"),
  v.literal("followup"),
  v.literal("collect"),
  v.literal("steer"),
);
/** Durable lifecycle for accepted ingress. */
export const ingressStatusValidator = v.union(
  v.literal("accepted"),
  v.literal("queued"),
  v.literal("applied"),
  v.literal("processing"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("expired"),
);
/** Fenced ownership and FIFO counters for one runtime conversation. */
export const runtimeConversationCoordinatorsFields = {
  accountId: v.string(),
  agentId: v.string(),
  conversationKey: v.string(),
  channelTarget: v.optional(
    v.object({
      agentConfig: v.any(),
      channelName: v.string(),
      source: v.record(v.string(), v.any()),
    }),
  ),
  nextSequence: v.number(),
  ownerGeneration: v.number(),
  ownerEventId: v.optional(v.string()),
  ownerTaskId: v.optional(v.string()),
  stopRequestedGeneration: v.optional(v.number()),
  leaseExpiresAt: v.optional(v.number()),
  queuedCount: v.number(),
  queuedBytes: v.number(),
  updatedAt: v.number(),
};
/** One accepted transport-neutral ingress item in the conversation FIFO. */
export const runtimeIngressEnvelopesFields = {
  accountId: v.string(),
  agentId: v.string(),
  conversationKey: v.string(),
  sequence: v.number(),
  eventId: v.string(),
  identity: v.string(),
  idempotencyKey: v.string(),
  payloadDigest: v.string(),
  events: v.array(v.any()),
  delivery: v.any(),
  requestedMode: ingressModeValidator,
  ownerTaskId: v.optional(v.string()),
  // Per-request execution context so a queued envelope runs with its own
  // resolved config and one-turn system, never the previous owner's.
  agentConfig: v.optional(v.any()),
  ephemeralSystem: v.optional(v.array(v.any())),
  appliedMode: v.optional(appliedIngressModeValidator),
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
  // Distinguishes a deliberate /stop from a genuine failure; both are terminal
  // "failed" so pollers keep one terminal bucket, but this reads intent.
  stoppedByUser: v.optional(v.boolean()),
  result: v.optional(v.any()),
};
/** Provenance for one steering, follow-up, or collected application. */
export const runtimeIngressApplicationsFields = {
  accountId: v.string(),
  conversationKey: v.string(),
  applicationId: v.string(),
  appliedMode: appliedIngressModeValidator,
  appliedToEventId: v.string(),
  contributingEventIds: v.array(v.string()),
  ownerGeneration: v.number(),
  createdAt: v.number(),
  expiresAt: v.number(),
};
/** Public async-agent polling and approval state. */
export const runtimeAsyncAgentResultsFields = {
  accountId: v.string(),
  eventId: v.string(),
  conversationKey: v.string(),
  status: v.union(
    v.literal("processing"),
    v.literal("awaiting_approval"),
    v.literal("completed"),
    v.literal("failed"),
  ),
  response: v.optional(v.any()),
  error: v.optional(v.string()),
  approvals: v.optional(v.array(v.any())),
  createdAt: v.string(),
  updatedAt: v.string(),
  expiresAt: v.number(),
};
/** Detached async tool state, including delivery and hashed callback authorization. */
export const runtimeAsyncToolResultsFields = {
  accountId: v.string(),
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
  delivery: v.optional(v.any()),
  completionTokenHash: v.optional(v.string()),
  observed: v.optional(v.boolean()),
  createdAt: v.string(),
  updatedAt: v.string(),
  expiresAt: v.number(),
};
/** Transactional fan-in group for detached tool siblings. */
export const runtimeAsyncToolGroupsFields = {
  accountId: v.string(),
  parentEventId: v.string(),
  resultIds: v.array(v.string()),
  sealed: v.boolean(),
  expiresAt: v.number(),
};
/** Authoritative persistent-sandbox reservation mapping. */
export const sandboxReservationsFields = {
  accountId: v.string(),
  provider: sandboxProviderValidator,
  reservationKey: v.string(),
  externalId: v.string(),
  expiresAt: v.number(),
};

/**
 * Per-account scheduled agent runs. Mirrors core's CronRecord
 * (apps/core/src/shared/domain/cron.ts) so the SaaS dashboard can manage them
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
  lastStatus: v.optional(
    v.union(v.literal("started"), v.literal("completed"), v.literal("failed")),
  ),
  lastError: v.optional(v.string()),
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

/**
 * Per-finished-task usage row. Written once per agent task at completion, giving
 * the dashboard a line-item token/compute cost per task. Indexes allow scoping to
 * a specific deployment (`endpointId`) or to the whole account. Pricing is
 * computed at render from a hardcoded shared pricing table — only raw counts are
 * stored here.
 */
export const taskUsageFields = {
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
   * the agent's own sandbox (role "agent") and the uploaded-tool runner (role
   * "tool"), tagged by compute `type` ("sandbox", "lambda", "mcp-sandbox";
   * retired rows carry "custom-tool-sandbox").
   * cpuUsec comes from the workdir exec report, the MicroVM getrusage report, and
   * the tool child's own cpuUsage respectively; others store 0.
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
 * Pre-aggregated token usage per (deployment, grain, time bucket, model),
 * upserted by the harness so the dashboard usage panel streams live without
 * scanning logs. Each sample folds into a 5-minute, an hour, and a day bucket
 * so long ranges read coarse rows instead of every 5-minute bucket. Buckets
 * are sparse (only active windows exist), so row count tracks real activity,
 * not wall-clock time.
 */
export const usageRollupsFields = {
  accountId: v.id("accounts"),
  endpointId: v.string(),
  /** Epoch ms floored (UTC) to the grain's bucket width. */
  bucketStart: v.number(),
  /**
   * Rollup grain. Optional because rows written before the field existed lack
   * it; a missing grain means "5m" until `migrations.backfillUsageRollupGrains`
   * stamps them. New rows always carry it.
   */
  grain: v.optional(
    v.union(v.literal("5m"), v.literal("hour"), v.literal("day")),
  ),
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
  users: defineTable(usersFields)
    .index("by_authId", ["authId"])
    .index("by_accountHandle", ["accountHandle"])
    .index("by_email", ["email"]),
  projects: defineTable(projectsFields)
    .index("by_authId", ["authId"])
    .index("by_authId_and_slug", ["authId", "slug"])
    // by_orgId looks redundant against the composite but is not: its callers
    // read in creation order, which prefixing the slug would silently reorder.
    .index("by_orgId", ["orgId"])
    .index("by_orgId_and_slug", ["orgId", "slug"]),
  stages: defineTable(stagesFields).index("by_projectId", ["projectId"]),
  agentConfigs: defineTable(agentConfigsFields)
    .index("by_authId", ["authId"])
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
    .index("by_projectId_and_stageId", ["projectId", "stageId"])
    .index("by_projectId_and_stageId_and_status", [
      "projectId",
      "stageId",
      "status",
    ])
    .index("by_apiKeyHash", ["apiKeyHash"])
    .index("by_endpointId", ["endpointId"])
    // The channel-endpoints reconcile walks every active deployment; a status
    // range keeps rotated/retired rows out of that read set.
    .index("by_status", ["status"])
    .index("by_accountId_and_status", ["accountId", "status"]),
  channelEndpoints: defineTable(channelEndpointsFields)
    .index("by_accountId", ["accountId"])
    .index("by_platform", ["platform"]),
  deployKeys: defineTable(deployKeysFields)
    .index("by_keyHash", ["keyHash"])
    .index("by_projectId_and_stageId", ["projectId", "stageId"]),
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
    .index("by_orgId", ["orgId"])
    .index("by_userId", ["userId"])
    .index("by_orgId_and_userId", ["orgId", "userId"]),
  accounts: defineTable(accountsFields)
    .index("by_orgId", ["orgId"])
    .index("by_secretHash", ["secretHash"]),
  agents: defineTable(agentsFields)
    .index("by_accountId", ["accountId"])
    .index("by_accountId_and_name", ["accountId", "name"]),
  accountHooks: defineTable(accountHooksFields)
    .index("by_accountId", ["accountId"])
    .index("by_accountId_and_status", ["accountId", "status"]),
  mcp: defineTable(mcpFields)
    .index("by_accountId_and_status", ["accountId", "status"])
    .index("by_stageId_and_status", ["stageId", "status"])
    .index("by_stageId_and_name", ["stageId", "name"])
    .index("by_stageId_and_nodeId", ["stageId", "nodeId"]),
  agentPolicies: defineTable(agentPoliciesFields)
    .index("by_accountId", ["accountId"])
    .index("by_accountId_and_status", ["accountId", "status"])
    .index("by_stageId_and_name", ["stageId", "name"])
    .index("by_stageId_and_status_and_name", ["stageId", "status", "name"]),
  accountRoles: defineTable(accountRolesFields)
    .index("by_accountId", ["accountId"])
    .index("by_roleId", ["roleId"]),
  roleSessions: defineTable(roleSessionsFields)
    .index("by_tokenHash", ["tokenHash"])
    .index("by_roleId", ["roleId"])
    .index("by_expiresAt", ["expiresAt"]),
  channelRecords: defineTable(channelRecordsFields)
    .index("by_accountId", ["accountId"])
    .index("by_accountId_and_status", ["accountId", "status"])
    // The inbound-webhook lookup: which record owns this place? `status` is in
    // the key because deleting leaves the row, so a place churned repeatedly
    // would otherwise make every inbound message read its whole history.
    .index("by_accountId_platform_external", [
      "accountId",
      "platform",
      "externalId",
      "status",
    ])
    .index("by_stageId_and_name", ["stageId", "name"]),
  sandboxConfigs: defineTable(sandboxConfigsFields)
    .index("by_accountId", ["accountId"])
    .index("by_accountId_and_name", ["accountId", "name"])
    .index("by_stageId_and_name", ["stageId", "name"]),
  workspaceConfigs: defineTable(workspaceConfigsFields)
    .index("by_accountId", ["accountId"])
    .index("by_accountId_and_name", ["accountId", "name"])
    .index("by_stageId_and_name", ["stageId", "name"]),
  sandboxInstances: defineTable(sandboxInstancesFields)
    .index("by_accountId", ["accountId"])
    .index("by_accountId_projectId_and_stageId", [
      "accountId",
      "projectId",
      "stageId",
    ])
    .index("by_lastUsedAt", ["lastUsedAt"])
    .index("by_reservationKey", ["reservationKey"]),
  sandboxSnapshots: defineTable(sandboxSnapshotsFields)
    .index("by_accountId", ["accountId"])
    .index("by_accountId_and_name", ["accountId", "name"]),
  sandboxAuditEvents: defineTable(sandboxAuditEventsFields)
    .index("by_accountId", ["accountId"])
    .index("by_accountId_and_reservationKey_and_createdAt", [
      "accountId",
      "reservationKey",
      "createdAt",
    ]),
  environmentVariables: defineTable(environmentVariablesFields)
    .index("by_projectId_and_stageId", ["projectId", "stageId"])
    .index("by_stageId_and_name", ["stageId", "name"]),
  accountEnvVars: defineTable(accountEnvVarsFields).index(
    "by_accountId_and_name",
    ["accountId", "name"],
  ),
  environmentVariableReveals: defineTable(environmentVariableRevealsFields)
    .index("by_stageId", ["stageId"])
    .index("by_revealedByAuthId", ["revealedByAuthId"])
    .index("by_revealedByCliAuthId", ["revealedByCliAuthId"]),
  configAuditEvents: defineTable(configAuditEventsFields).index("by_account", [
    "accountId",
  ]),
  configHttpAuthFailures: defineTable(configHttpAuthFailuresFields)
    .index("by_key", ["key"])
    .index("by_updatedAt", ["updatedAt"]),
  skills: defineTable(skillsFields).index("by_accountId", ["accountId"]),
  workspaceFiles: defineTable(workspaceFilesFields)
    .index("by_projectId_and_nodeId", ["projectId", "nodeId"])
    .index("by_projectId_nodeId_and_path", ["projectId", "nodeId", "path"]),
  workspaceDownloadTokens: defineTable(workspaceDownloadTokensFields)
    .index("by_tokenHash", ["tokenHash"])
    .index("by_accountId", ["accountId"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_expiresAt", ["expiresAt"]),
  runtimeConversationEvents: defineTable(runtimeConversationEventsFields)
    .index("by_conversationKey_and_cursor", ["conversationKey", "cursor"])
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
    .index("by_conversationKey_and_sequence", ["conversationKey", "sequence"])
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
    .index("by_accountId", ["accountId"])
    // Status leads so maintenance scans only nonterminal rows: terminal rows
    // keep their stale expiresAt for the whole status retention window, and a
    // bare expiresAt index would re-read every one of them each sweep.
    .index("by_status_and_expiresAt", ["status", "expiresAt"])
    .index("by_status_and_statusExpiresAt", ["status", "statusExpiresAt"]),
  runtimeIngressApplications: defineTable(runtimeIngressApplicationsFields)
    .index("by_conversationKey_and_createdAt", ["conversationKey", "createdAt"])
    .index("by_accountId", ["accountId"])
    .index("by_expiresAt", ["expiresAt"]),
  runtimeAsyncAgentResults: defineTable(runtimeAsyncAgentResultsFields)
    .index("by_eventId", ["eventId"])
    .index("by_accountId", ["accountId"])
    .index("by_conversationKey", ["conversationKey"])
    .index("by_expiresAt", ["expiresAt"]),
  runtimeAsyncToolResults: defineTable(runtimeAsyncToolResultsFields)
    .index("by_resultId", ["resultId"])
    .index("by_parentEventId", ["parentEventId"])
    .index("by_accountId", ["accountId"])
    .index("by_conversationKey", ["conversationKey"])
    .index("by_expiresAt", ["expiresAt"]),
  runtimeAsyncToolGroups: defineTable(runtimeAsyncToolGroupsFields)
    .index("by_parentEventId", ["parentEventId"])
    .index("by_accountId", ["accountId"])
    .index("by_expiresAt", ["expiresAt"]),
  sandboxReservations: defineTable(sandboxReservationsFields)
    .index("by_provider_and_reservationKey", ["provider", "reservationKey"])
    .index("by_accountId", ["accountId"])
    .index("by_expiresAt", ["expiresAt"]),
  crons: defineTable(cronsFields)
    .index("by_accountId", ["accountId"])
    .index("by_accountId_and_agentId", ["accountId", "agentId"]),
  cronRuns: defineTable(cronRunsFields).index(
    "by_accountId_and_cronId_and_startedAt",
    ["accountId", "cronId", "startedAt"],
  ),
  taskUsage: defineTable(taskUsageFields)
    .index("by_accountId_and_finishedAt", ["accountId", "finishedAt"])
    .index("by_accountId_and_taskId", ["accountId", "taskId"]),
  usageRollups: defineTable(usageRollupsFields)
    .index("by_endpointId_and_bucketStart", ["endpointId", "bucketStart"])
    .index("by_endpointId_and_grain_and_bucketStart", [
      "endpointId",
      "grain",
      "bucketStart",
    ])
    .index("by_accountId_endpointId_bucketStart_modelProvider_modelId", [
      "accountId",
      "endpointId",
      "bucketStart",
      "modelProvider",
      "modelId",
    ]),
});
