/**
 * Mirror of core's self-config proposal contract (ticket 21,
 * apps/core/src/shared/domain/self-config.ts) — the dashboard cannot import
 * core, so the shape is mirrored here and validated against captured frames
 * (the ticket-14 method) in tests/selfConfigProposals.test.ts. A proposal
 * arrives as the OUTPUT of a propose_* tool part in the chat stream; the
 * Test tab renders it as a card whose approve action runs the same
 * `*Public.ts` writes the manual tabs use.
 */

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

export interface SelfConfigProposalResult {
  version: typeof SELF_CONFIG_PROPOSAL_VERSION;
  proposal: SelfConfigProposal;
  status: "pending_user_review";
}

/** The propose_* tool names (must match core's toolset registration). */
export const PROPOSAL_TOOL_NAMES = new Set([
  "propose_skill",
  "propose_config_change",
  "propose_connector",
  "request_credential",
  "propose_context_folder",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isValidProposal(value: unknown): value is SelfConfigProposal {
  if (!isRecord(value) || !isRecord(value.payload)) return false;
  const payload = value.payload;
  switch (value.kind) {
    case "skill":
      return (
        typeof payload.name === "string" &&
        typeof payload.description === "string" &&
        typeof payload.skillMd === "string"
      );
    case "config_change":
      return isRecord(payload.patch) && typeof payload.reason === "string";
    case "connector":
      if (payload.kind === "mcp") {
        return (
          typeof payload.label === "string" && typeof payload.url === "string"
        );
      }

      return (
        payload.kind === "token" &&
        typeof payload.provider === "string" &&
        typeof payload.label === "string"
      );
    case "credential_request":
      return (
        typeof payload.provider === "string" &&
        isStringArray(payload.fields) &&
        typeof payload.reason === "string"
      );
    case "context_folder":
      return typeof payload.name === "string";
    default:
      return false;
  }
}

/**
 * Parse a propose_* tool part's output into a proposal, or null when the
 * output is anything else. Accepts the object form (live stream) and the
 * JSON-string form (some transports stringify tool outputs).
 */
export function parseProposalResult(
  output: unknown,
): SelfConfigProposalResult | null {
  let value = output;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  if (value.version !== SELF_CONFIG_PROPOSAL_VERSION) return null;
  if (value.status !== "pending_user_review") return null;
  if (!isValidProposal(value.proposal)) return null;

  return value as unknown as SelfConfigProposalResult;
}

/** One-line human title for a proposal card. */
export function proposalTitle(proposal: SelfConfigProposal): string {
  switch (proposal.kind) {
    case "skill":
      return `New skill: ${proposal.payload.name}`;
    case "config_change":
      return "Configuration change";
    case "connector":
      return proposal.payload.kind === "mcp"
        ? `Connect MCP server: ${proposal.payload.label}`
        : `Connect ${proposal.payload.provider}: ${proposal.payload.label}`;
    case "credential_request":
      return `Credential needed for ${proposal.payload.provider}`;
    case "context_folder":
      return `Create working folder: ${proposal.payload.name}`;
  }
}

/**
 * The automatic follow-up posted into the conversation after a decision so
 * the agent knows the outcome. Rendered as a system-ish note (see
 * isOutcomeNote), and NEVER contains a submitted secret.
 */
export function outcomeNote(
  decision: "approved" | "declined" | "failed",
  detail: string,
): string {
  const label =
    decision === "approved"
      ? "Approved"
      : decision === "declined"
        ? "Declined"
        : "Failed";

  return `[${label} — ${detail}]`;
}

/** True for user messages that are automatic decision notes, not typed prose. */
export function isOutcomeNote(text: string): boolean {
  return /^\[(Approved|Declined|Failed) — [\s\S]*\]$/.test(text.trim());
}
