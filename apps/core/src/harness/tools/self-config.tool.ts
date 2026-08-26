/**
 * Self-configuration toolset (ticket 21). Registered ONLY for owner sessions
 * (dashboard internal test endpoint, account auth + owner-session marker).
 * Everything here is read or propose — the runtime never writes config; a
 * proposal is a structured tool result the dashboard renders as a card and
 * the OWNER's identity applies (ticket 22). No secret ever reaches the model:
 * reads go through sanitizeConfigForSelfInspection or drop encrypted fields.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { AgentConfig } from "../../shared/domain/agent-config.ts";
import {
  isAllowedConfigChangePatch,
  proposalResult,
  sanitizeConfigForSelfInspection,
  CONFIG_CHANGE_ALLOWED_PATHS,
} from "../../shared/domain/self-config.ts";
import {
  deleteS3Object,
  listS3Prefix,
  readS3Text,
  s3ObjectExists,
  writeS3Object,
} from "../../shared/s3.ts";
import {
  parseSkillMarkdown,
  skillsBucketName,
  SKILL_FILE,
} from "../../shared/skills.ts";
import type { ResolvedWorkspace } from "../../shared/workspaces.ts";
import { optionalEnv } from "../../shared/env.ts";
import { logWarn } from "../../shared/log.ts";
import { runtime } from "../../shared/convex/runtime.ts";
import { createConnectorTools, type ConnectorRow } from "../connectors.ts";
import { toolError } from "./utils.ts";

const SKILL_LIBRARY_LIMIT = 100;
const RECENT_FAILURES_LIMIT = 10;

export interface SelfConfigToolContext {
  accountId: string;
  agentId?: string;
  workspaces?: ResolvedWorkspace[];
}

interface SkillLibraryEntry {
  name: string;
  description?: string;
  path: string;
  enabledForThisAgent: boolean;
}

interface ConnectorListing {
  connectorId: string;
  provider: string;
  label: string;
  authKind: string;
  url?: string;
  enabled: boolean;
  status: string;
  lastError?: string;
  lastCheckedAt?: number;
  validatedLogin?: string;
  toolNames?: string[];
}

interface HealthCheckResult {
  name: string;
  target: string;
  ok: boolean;
  detail: string;
}

/** A failure row as served by `internal.runtimeIngress.listRecentAgentFailures`. */
interface FailureRow {
  conversationKey: string;
  error?: string;
  stoppedByUser?: boolean;
  updatedAt: number;
  eventId: string;
}

export function createSelfConfigTools(
  context: SelfConfigToolContext,
  agentConfig: AgentConfig,
): ToolSet {
  const accountId = context.accountId;

  return {
    read_own_config: tool({
      description:
        "Read your own configuration (sanitized — no keys or secrets): model, system prompt, enabled skills, connectors, workspaces, channels, public access.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => sanitizeConfigForSelfInspection(agentConfig),
    }),

    list_skill_library: tool({
      description:
        "List the account's skill library (name and description of every stored skill) and which skills are enabled for you.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => listSkillLibrary(accountId, agentConfig),
    }),

    list_connectors: tool({
      description:
        "List the connectors configured for you (provider, label, status, last error — never secrets) plus which chat channels are configured.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => ({
        connectors: await listConnectorRows(accountId, agentConfig),
        channelsConfigured: Object.keys(agentConfig.channels ?? {}),
      }),
    }),

    read_recent_failures: tool({
      description:
        "Read your recent failed or errored runs (most recent first) with the actual error message of each.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => {
        if (!context.agentId) {
          return { failures: [], note: "No agent id on this session." };
        }
        const failures = (await runtime.query("listRecentAgentFailures", {
          accountId: accountId,
          agentId: context.agentId,
          limit: RECENT_FAILURES_LIMIT,
        })) as FailureRow[];

        return {
          failures: failures.map((row) => ({
            when: new Date(row.updatedAt).toISOString(),
            error: row.error ?? "Run failed without a recorded error message",
            stoppedByUser: row.stoppedByUser === true,
            conversationKey: row.conversationKey,
          })),
        };
      },
    }),

    run_health_check: tool({
      description:
        "Run a health check over your own configuration: model key wiring, each enabled skill resolves to real content, each enabled connector responds, each working folder is readable and writable. Reports the specific broken part.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => ({
        checks: await runHealthCheck(context, agentConfig),
      }),
    }),

    propose_skill: tool({
      description:
        "Propose a new skill for this account's library. The owner reviews and applies it — nothing is written until they approve.",
      inputSchema: jsonSchema<{
        name: string;
        description: string;
        skillMd: string;
      }>({
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Skill name: lowercase letters, digits and hyphens (used as the folder name).",
          },
          description: {
            type: "string",
            description: "One-line description of when to use the skill.",
          },
          skillMd: {
            type: "string",
            description:
              "Full SKILL.md content, starting with YAML frontmatter carrying name and description.",
          },
        },
        required: ["name", "description", "skillMd"],
        additionalProperties: false,
      }),
      execute: async ({ name, description, skillMd }) => {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
          return toolError(
            "Skill name must be lowercase letters, digits and hyphens.",
          );
        }
        if (!/^---\r?\n[\s\S]*?\r?\n---/.test(skillMd.trim())) {
          return toolError(
            "skillMd must start with YAML frontmatter (--- name/description ---).",
          );
        }

        return proposalResult({
          kind: "skill",
          payload: { name: name, description: description, skillMd: skillMd },
        });
      },
    }),

    propose_config_change: tool({
      description: `Propose a change to your own configuration. The patch may only touch: ${CONFIG_CHANGE_ALLOWED_PATHS.join(", ")}. The owner reviews and applies it.`,
      inputSchema: jsonSchema<{
        patch: Record<string, unknown>;
        reason: string;
      }>({
        type: "object",
        properties: {
          patch: {
            type: "object",
            description:
              'Nested config patch, e.g. {"agent":{"system":"..."}} or {"skills":{"allowed":[...]}}.',
          },
          reason: {
            type: "string",
            description: "Why this change helps, in one or two sentences.",
          },
        },
        required: ["patch", "reason"],
        additionalProperties: false,
      }),
      execute: async ({ patch, reason }) => {
        if (!isAllowedConfigChangePatch(patch)) {
          return toolError(
            `Patch touches a branch outside the allowlist. Allowed: ${CONFIG_CHANGE_ALLOWED_PATHS.join(", ")}.`,
          );
        }

        return proposalResult({
          kind: "config_change",
          payload: { patch: patch, reason: reason },
        });
      },
    }),

    propose_connector: tool({
      description:
        "Propose adding a connector (an MCP server by URL, or a token-based provider like GitHub). The owner reviews it; any credential is collected from the owner directly, never through you.",
      inputSchema: jsonSchema<{
        kind: "mcp" | "token";
        label: string;
        url?: string;
        provider?: string;
      }>({
        type: "object",
        properties: {
          kind: { type: "string", enum: ["mcp", "token"] },
          label: { type: "string", description: "Short human label." },
          url: {
            type: "string",
            description: "MCP server URL (kind mcp only).",
          },
          provider: {
            type: "string",
            description: "Provider name, e.g. github (kind token only).",
          },
        },
        required: ["kind", "label"],
        additionalProperties: false,
      }),
      execute: async ({ kind, label, url, provider }) => {
        if (kind === "mcp") {
          if (!url || !/^https?:\/\//.test(url)) {
            return toolError("An MCP connector proposal needs an http(s) url.");
          }

          return proposalResult({
            kind: "connector",
            payload: { kind: "mcp", label: label, url: url },
          });
        }
        if (!provider) {
          return toolError("A token connector proposal needs a provider.");
        }

        return proposalResult({
          kind: "connector",
          payload: { kind: "token", provider: provider, label: label },
        });
      },
    }),

    request_credential: tool({
      description:
        "Ask the owner for a credential (API key, token) through a secure card. The value goes straight to encrypted storage — it never comes back through you, and you must never ask the owner to paste a secret into chat.",
      inputSchema: jsonSchema<{
        provider: string;
        fields: string[];
        reason: string;
      }>({
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "What the credential is for.",
          },
          fields: {
            type: "array",
            items: { type: "string" },
            description: 'Field names needed, e.g. ["token"].',
          },
          reason: { type: "string", description: "Why you need it." },
        },
        required: ["provider", "fields", "reason"],
        additionalProperties: false,
      }),
      execute: async ({ provider, fields, reason }) =>
        proposalResult({
          kind: "credential_request",
          payload: { provider: provider, fields: fields, reason: reason },
        }),
    }),

    propose_context_folder: tool({
      description:
        "Propose creating a working folder (context/files workspace) for yourself. The owner reviews and creates it.",
      inputSchema: jsonSchema<{ name: string }>({
        type: "object",
        properties: {
          name: { type: "string", description: "Folder name." },
        },
        required: ["name"],
        additionalProperties: false,
      }),
      execute: async ({ name }) =>
        proposalResult({ kind: "context_folder", payload: { name: name } }),
    }),
  };
}

async function listSkillLibrary(
  accountId: string,
  agentConfig: AgentConfig,
): Promise<{ skills: SkillLibraryEntry[]; truncated: boolean }> {
  const enabled = new Set(agentConfig.skills?.allowed ?? []);
  const objects = await listS3Prefix(skillsBucketName(), `${accountId}/`);
  const skillKeys = objects
    .map((object) => object.key)
    .filter((key) => key.endsWith(`/${SKILL_FILE}`));
  const truncated = skillKeys.length > SKILL_LIBRARY_LIMIT;
  const skills = await Promise.all(
    skillKeys.slice(0, SKILL_LIBRARY_LIMIT).map(async (key) => {
      const path = key.slice(0, -(SKILL_FILE.length + 1));
      const entry: SkillLibraryEntry = {
        name: path.slice(accountId.length + 1),
        path: path,
        enabledForThisAgent: enabled.has(path),
      };
      try {
        const markdown = await readS3Text(skillsBucketName(), key);
        const metadata = parseSkillMarkdown(markdown);
        if (metadata.description) entry.description = metadata.description;
      } catch (err) {
        logWarn("self-config: skill metadata unreadable", {
          key: key,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return entry;
    }),
  );

  return { skills: skills, truncated: truncated };
}

async function listConnectorRows(
  accountId: string,
  agentConfig: AgentConfig,
): Promise<ConnectorListing[]> {
  const refs = agentConfig.connectors?.allowed ?? [];
  if (refs.length === 0) return [];
  const rows = (await runtime.query("listConnectors", {
    accountId: accountId,
    connectorIds: refs.map((ref) => ref.connectorId),
  })) as Array<
    ConnectorRow & {
      lastError?: string;
      lastCheckedAt?: number;
      validatedLogin?: string;
    }
  >;
  const enabledById = new Map(
    refs.map((ref) => [ref.connectorId, ref.enabled]),
  );

  // Deliberately no encrypted fields here — this is the model-facing view.
  return rows.map((row) => ({
    connectorId: row._id,
    provider: row.provider,
    label: row.label,
    authKind: row.authKind,
    ...(row.url ? { url: row.url } : {}),
    enabled: enabledById.get(row._id) === true,
    status: row.status,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.lastCheckedAt ? { lastCheckedAt: row.lastCheckedAt } : {}),
    ...(row.validatedLogin ? { validatedLogin: row.validatedLogin } : {}),
    ...(row.toolNames ? { toolNames: row.toolNames } : {}),
  }));
}

async function runHealthCheck(
  context: SelfConfigToolContext,
  agentConfig: AgentConfig,
): Promise<HealthCheckResult[]> {
  const checks: HealthCheckResult[] = [];

  // Model provider wiring: config-level. A live provider ping would spend
  // model tokens on every check, so this verifies the key material is present
  // and resolved (an unresolved ${VAR} reference is the live failure mode).
  const providerName = agentConfig.model?.provider;
  if (!providerName) {
    checks.push({
      name: "model",
      target: "config.model",
      ok: false,
      detail: "No model provider configured.",
    });
  } else {
    const providerBranch = agentConfig.provider?.[providerName];
    const apiKey =
      providerBranch && typeof providerBranch === "object"
        ? (providerBranch as Record<string, unknown>).apiKey
        : undefined;
    if (typeof apiKey === "string" && apiKey.includes("${")) {
      checks.push({
        name: "model",
        target: `config.provider.${providerName}.apiKey`,
        ok: false,
        detail: `API key reference ${apiKey} did not resolve — the environment variable is missing on this stage.`,
      });
    } else if (typeof apiKey === "string" && apiKey.trim().length > 0) {
      checks.push({
        name: "model",
        target: `config.provider.${providerName}.apiKey`,
        ok: true,
        detail: "API key is present and resolved.",
      });
    } else {
      checks.push({
        name: "model",
        target: `config.provider.${providerName}`,
        ok: true,
        detail:
          "No apiKey field — provider may authenticate another way (not checked).",
      });
    }
  }

  // Each enabled skill must resolve to real stored content.
  for (const path of agentConfig.skills?.allowed ?? []) {
    const exists = await s3ObjectExists(
      skillsBucketName(),
      `${path}/${SKILL_FILE}`,
    ).catch(() => false);
    checks.push({
      name: "skill",
      target: path,
      ok: exists,
      detail: exists
        ? "SKILL.md found."
        : "Enabled skill has no stored SKILL.md — remove or re-create it.",
    });
  }

  // Each enabled connector must actually produce tools (for MCP this is a
  // real initialize → tools/list round-trip; a token connector registers
  // without a network call, so its stored status row is the verdict).
  const refs = (agentConfig.connectors?.allowed ?? []).filter(
    (ref) => ref.enabled,
  );
  if (refs.length > 0) {
    const rows = await listConnectorRows(context.accountId, agentConfig);
    const rowById = new Map(rows.map((row) => [row.connectorId, row]));
    for (const ref of refs) {
      const row = rowById.get(ref.connectorId);
      if (!row) {
        checks.push({
          name: "connector",
          target: ref.connectorId,
          ok: false,
          detail: "Enabled connector row no longer exists.",
        });
        continue;
      }
      if (row.authKind === "mcp") {
        const tools = await createConnectorTools(context.accountId, {
          allowed: [ref],
        });
        const toolCount = Object.keys(tools).length;
        checks.push({
          name: "connector",
          target: row.label,
          ok: toolCount > 0,
          detail:
            toolCount > 0
              ? `MCP server reachable, ${toolCount} tool(s).`
              : `MCP server did not answer initialize/tools-list${row.lastError ? ` (last error: ${row.lastError})` : ""}.`,
        });
      } else {
        checks.push({
          name: "connector",
          target: row.label,
          ok: row.status === "connected",
          detail:
            row.status === "connected"
              ? `Token validated${row.validatedLogin ? ` as ${row.validatedLogin}` : ""}.`
              : (row.lastError ?? "Connector is in error state."),
        });
      }
    }
  }

  // Working folders: write, read back, delete a temp object in each namespace.
  const workspaceBucket = optionalEnv("FILESYSTEM_BUCKET_NAME");
  for (const workspace of context.workspaces ?? []) {
    if (!workspaceBucket) {
      checks.push({
        name: "workspace",
        target: workspace.name,
        ok: true,
        detail: "No filesystem bucket on this runtime (not checked).",
      });
      continue;
    }
    const key = `${workspace.namespace}/.broods_health_check.tmp`;
    try {
      const stamp = `health-check ${Date.now()}`;
      await writeS3Object(workspaceBucket, key, stamp, {
        contentType: "text/plain",
      });
      const readBack = await readS3Text(workspaceBucket, key);
      await deleteS3Object(workspaceBucket, key);
      checks.push({
        name: "workspace",
        target: workspace.name,
        ok: readBack === stamp,
        detail:
          readBack === stamp
            ? "Read-write-delete round-trip OK."
            : "Round-trip wrote but read back different content.",
      });
    } catch (err) {
      checks.push({
        name: "workspace",
        target: workspace.name,
        ok: false,
        detail: `Round-trip failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return checks;
}
