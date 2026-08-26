/**
 * Self-configuration contract (ticket 21): the stable, versioned proposal
 * shapes the owner-session tools return, and the sanitized self-inspection
 * view of an agent's config. The dashboard mirrors these types and renders
 * proposals as approval cards (ticket 22); the runtime stays read-only —
 * every change is applied by the user's identity, never by the agent.
 */

import { isPlainObject } from "../object.ts";
import type { AgentConfig } from "./agent-config.ts";

export const SELF_CONFIG_PROPOSAL_VERSION = 1;

export type SelfConfigProposal =
  | {
      kind: "skill";
      payload: { name: string; description: string; skillMd: string };
    }
  | {
      kind: "config_change";
      payload: { patch: Record<string, unknown>; reason: string };
    }
  | {
      kind: "connector";
      payload:
        | { kind: "mcp"; label: string; url: string }
        | { kind: "token"; provider: string; label: string };
    }
  | {
      kind: "credential_request";
      payload: { provider: string; fields: string[]; reason: string };
    }
  | {
      kind: "context_folder";
      payload: { name: string };
    };

/** What every propose tool returns; ticket 22 renders this as a card. */
export interface SelfConfigProposalResult {
  version: typeof SELF_CONFIG_PROPOSAL_VERSION;
  proposal: SelfConfigProposal;
  status: "pending_user_review";
}

export function proposalResult(
  proposal: SelfConfigProposal,
): SelfConfigProposalResult {
  return {
    version: SELF_CONFIG_PROPOSAL_VERSION,
    proposal: proposal,
    status: "pending_user_review",
  };
}

/** Branches `propose_config_change` may touch. Anything else is a tool error. */
export const CONFIG_CHANGE_ALLOWED_PATHS = [
  "agent.system",
  "model",
  "skills.allowed",
  "connectors.allowed",
  "workspaces",
] as const;

/**
 * True when a proposed patch touches only allowlisted paths. The patch is a
 * nested object: top-level keys must be `model`/`skills`/`connectors`/
 * `workspaces`/`agent`, and `agent` may only carry `system`, `skills` only
 * `allowed`, `connectors` only `allowed`.
 */
export function isAllowedConfigChangePatch(patch: unknown): boolean {
  if (!isPlainObject(patch)) return false;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "model" || key === "workspaces") continue;
    if (key === "agent") {
      if (!isPlainObject(value)) return false;
      if (Object.keys(value).some((inner) => inner !== "system")) return false;
      continue;
    }
    if (key === "skills" || key === "connectors") {
      if (!isPlainObject(value)) return false;
      if (Object.keys(value).some((inner) => inner !== "allowed")) return false;
      continue;
    }

    return false;
  }

  return Object.keys(patch).length > 0;
}

/** The sanitized view `read_own_config` returns. Never carries a secret. */
export interface SelfInspectionView {
  name?: string;
  description?: string;
  system?: string;
  model: { provider?: string; modelId?: string };
  publicAccess: boolean;
  skills: { allowed: string[] };
  connectors: {
    allowed: Array<{ provider: string; connectorId: string; enabled: boolean }>;
  };
  workspaces: Array<{ name: string; workspaceId: string }>;
  channelsConfigured: string[];
  schedulerEnabled: boolean;
}

/**
 * Build the secrets-free self-inspection view. Nothing from
 * `config.provider` (API keys), channel configs (tokens/secrets), or
 * runtime variables survives — only names and shapes.
 */
export function sanitizeConfigForSelfInspection(
  config: AgentConfig,
): SelfInspectionView {
  const agentBranch = isPlainObject(config.agent)
    ? (config.agent as Record<string, unknown>)
    : {};

  return {
    ...(typeof agentBranch.name === "string" ? { name: agentBranch.name } : {}),
    ...(typeof agentBranch.description === "string"
      ? { description: agentBranch.description }
      : {}),
    ...(typeof agentBranch.system === "string"
      ? { system: agentBranch.system }
      : {}),
    model: {
      ...(config.model?.provider ? { provider: config.model.provider } : {}),
      ...(typeof config.model?.modelId === "string"
        ? { modelId: config.model.modelId }
        : {}),
    },
    publicAccess: config.publicAccess === true,
    skills: { allowed: [...(config.skills?.allowed ?? [])] },
    connectors: {
      allowed: (config.connectors?.allowed ?? []).map((ref) => ({
        provider: ref.provider,
        connectorId: ref.connectorId,
        enabled: ref.enabled,
      })),
    },
    workspaces: (config.workspaces ?? []).map((ref) => ({
      name: ref.name,
      workspaceId: ref.workspaceId,
    })),
    channelsConfigured: Object.keys(config.channels ?? {}),
    schedulerEnabled: config.scheduler?.enabled === true,
  };
}
