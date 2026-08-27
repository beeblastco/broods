import { describe, expect, test } from "bun:test";
import {
  isOutcomeNote,
  outcomeNote,
  parseProposalResult,
  proposalTitle,
} from "../app/lib/selfConfigProposals";

/**
 * Ground truth: outputs captured from core's ACTUAL propose_* tool
 * implementations (apps/core/src/harness/tools/self-config.tool.ts) by
 * executing them directly — the ticket-14 captured-frame method. The live
 * stream delivers these verbatim as the tool part's `output`. If core's
 * shape drifts, these fixtures must be re-captured, not hand-edited.
 */
const CAPTURED = {
  propose_skill: {
    version: 1,
    proposal: {
      kind: "skill",
      payload: {
        name: "import-tickets",
        description: "Import customer tickets",
        skillMd:
          "---\nname: import-tickets\ndescription: Import customer tickets\n---\n\nSteps here.",
      },
    },
    status: "pending_user_review",
  },
  propose_config_change: {
    version: 1,
    proposal: {
      kind: "config_change",
      payload: {
        patch: { agent: { system: "Always answer in Vietnamese." } },
        reason: "Owner asked for Vietnamese replies.",
      },
    },
    status: "pending_user_review",
  },
  propose_connector_mcp: {
    version: 1,
    proposal: {
      kind: "connector",
      payload: {
        kind: "mcp",
        label: "Weather",
        url: "https://mcp.example.com/weather",
      },
    },
    status: "pending_user_review",
  },
  propose_connector_token: {
    version: 1,
    proposal: {
      kind: "connector",
      payload: { kind: "token", provider: "github", label: "GitHub" },
    },
    status: "pending_user_review",
  },
  request_credential: {
    version: 1,
    proposal: {
      kind: "credential_request",
      payload: {
        provider: "github",
        fields: ["token"],
        reason: "To read your PRs.",
      },
    },
    status: "pending_user_review",
  },
  propose_context_folder: {
    version: 1,
    proposal: { kind: "context_folder", payload: { name: "notes" } },
    status: "pending_user_review",
  },
};

describe("parseProposalResult on captured core frames", () => {
  test("accepts every captured frame, object and JSON-string form", () => {
    for (const frame of Object.values(CAPTURED)) {
      expect(parseProposalResult(frame)).toEqual(
        frame as ReturnType<typeof parseProposalResult> & object,
      );
      expect(parseProposalResult(JSON.stringify(frame))).toEqual(
        frame as ReturnType<typeof parseProposalResult> & object,
      );
    }
  });

  test("rejects non-proposal tool outputs", () => {
    expect(parseProposalResult(null)).toBe(null);
    expect(parseProposalResult("plain text tool result")).toBe(null);
    expect(parseProposalResult({ schedules: [] })).toBe(null);
    expect(
      parseProposalResult({
        version: 2,
        proposal: {},
        status: "pending_user_review",
      }),
    ).toBe(null);
    expect(
      parseProposalResult({
        version: 1,
        proposal: { kind: "skill", payload: { name: "x" } },
        status: "pending_user_review",
      }),
    ).toBe(null);
    expect(
      parseProposalResult({
        version: 1,
        proposal: CAPTURED.propose_skill.proposal,
        status: "applied",
      }),
    ).toBe(null);
  });

  test("titles are specific per kind", () => {
    expect(
      proposalTitle(parseProposalResult(CAPTURED.propose_skill)!.proposal),
    ).toBe("New skill: import-tickets");
    expect(
      proposalTitle(
        parseProposalResult(CAPTURED.propose_connector_mcp)!.proposal,
      ),
    ).toBe("Connect MCP server: Weather");
    expect(
      proposalTitle(parseProposalResult(CAPTURED.request_credential)!.proposal),
    ).toBe("Credential needed for github");
  });
});

describe("outcome notes", () => {
  test("round-trips through the note detector", () => {
    const approved = outcomeNote(
      "approved",
      "skill 'import-tickets' saved to library and enabled",
    );
    expect(approved).toBe(
      "[Approved — skill 'import-tickets' saved to library and enabled]",
    );
    expect(isOutcomeNote(approved)).toBe(true);
    expect(isOutcomeNote(outcomeNote("declined", "connector"))).toBe(true);
    expect(isOutcomeNote(outcomeNote("failed", "MCP handshake: boom"))).toBe(
      true,
    );
  });

  test("does not flag ordinary user prose", () => {
    expect(isOutcomeNote("Approve it please")).toBe(false);
    expect(isOutcomeNote("[weird bracket message")).toBe(false);
  });
});
