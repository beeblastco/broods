"use client";

/**
 * Proposal cards (ticket 22): each self-config proposal a tested agent makes
 * (ticket 21's propose_* tools) renders as a card with Approve/Decline.
 * Approving runs the SAME `*Public.ts` writes the manual tabs use, under the
 * signed-in user's identity — one config plane, chat and tabs can never
 * disagree. Credential values go browser → connectorsPublic/agentConfig
 * directly; they never enter the transcript, the model context, or the
 * outcome notes.
 */

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { toErrorMessage } from "@/app/lib/errors";
import {
  outcomeNote,
  proposalTitle,
  type SelfConfigProposal,
  type SelfConfigProposalResult,
} from "@/app/lib/selfConfigProposals";
import { isPlainObject } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { useCallback, useState } from "react";

export interface ProposalDecision {
  status: "applied" | "declined" | "failed";
  detail: string;
}

/** Channel kinds whose credentials save into `config.channels.<kind>`. */
const CHANNEL_CREDENTIAL_KINDS = new Set([
  "telegram",
  "slack",
  "discord",
  "zalo",
  "pancake",
]);

export function ProposalCard({
  result,
  toolCallId,
  agentConfigId,
  decision,
  onDecided,
}: {
  result: SelfConfigProposalResult;
  toolCallId: string;
  agentConfigId: Id<"agentConfigs">;
  decision?: ProposalDecision;
  /** Records the decision and posts the outcome note into the conversation. */
  onDecided: (
    toolCallId: string,
    decision: ProposalDecision,
    note: string,
  ) => void;
}): React.JSX.Element {
  const proposal = result.proposal;
  const agentConfig = useQuery(api.agentConfig.getById, {
    configId: agentConfigId,
  });
  const updateConfig = useMutation(api.agentConfig.update);
  const createSkill = useAction(api.skillsPublic.createFromJson);
  const createMcp = useAction(api.connectorsPublic.createCustomMcpConnector);
  const createToken = useAction(api.connectorsPublic.createTokenConnector);
  const createFolder = useMutation(
    api.workspaceConfigsPublic.createWorkingFolder,
  );

  const [busy, setBusy] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string>>({});

  const settled =
    decision?.status === "applied" || decision?.status === "declined";

  /** Merge one nested branch into extraConfig without clobbering siblings. */
  const mergeExtraBranch = useCallback(
    async (branch: string, value: unknown) => {
      if (!agentConfig) throw new Error("Agent config not loaded yet.");
      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      const currentBranch = isPlainObject(currentExtra[branch])
        ? (currentExtra[branch] as Record<string, unknown>)
        : {};
      await updateConfig({
        configId: agentConfigId,
        extraConfig: {
          ...currentExtra,
          [branch]: isPlainObject(value)
            ? { ...currentBranch, ...value }
            : value,
        },
      });
    },
    [agentConfig, agentConfigId, updateConfig],
  );

  const enableConnector = useCallback(
    async (provider: string, connectorId: string) => {
      if (!agentConfig) throw new Error("Agent config not loaded yet.");
      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      const branch = isPlainObject(currentExtra.connectors)
        ? (currentExtra.connectors as Record<string, unknown>)
        : {};
      const allowed = Array.isArray(branch.allowed)
        ? (branch.allowed as Array<{
            provider: string;
            connectorId: string;
            enabled: boolean;
          }>)
        : [];
      await mergeExtraBranch("connectors", {
        allowed: [
          ...allowed.filter((ref) => ref.connectorId !== connectorId),
          { provider: provider, connectorId: connectorId, enabled: true },
        ],
      });
    },
    [agentConfig, mergeExtraBranch],
  );

  const decide = useCallback(
    (next: ProposalDecision) => {
      const label =
        next.status === "applied"
          ? "approved"
          : next.status === "declined"
            ? "declined"
            : "failed";
      onDecided(toolCallId, next, outcomeNote(label, next.detail));
    },
    [onDecided, toolCallId],
  );

  const runAction = useCallback(
    async (action: () => Promise<string>) => {
      setBusy(true);
      try {
        const detail = await action();
        decide({ status: "applied", detail: detail });
      } catch (err) {
        decide({ status: "failed", detail: toErrorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [decide],
  );

  const decline = useCallback(() => {
    decide({ status: "declined", detail: proposalTitle(proposal) });
  }, [decide, proposal]);

  // --- per-kind approve implementations (the same writes the tabs use) ---

  const approveSkill = useCallback(
    async (enable: boolean) => {
      if (proposal.kind !== "skill") return;
      await runAction(async () => {
        const created = await createSkill({
          name: proposal.payload.name,
          description: proposal.payload.description,
          content: proposal.payload.skillMd,
        });
        if (enable) {
          if (!agentConfig) throw new Error("Agent config not loaded yet.");
          const currentExtra =
            (agentConfig.extraConfig as Record<string, unknown>) ?? {};
          const branch = isPlainObject(currentExtra.skills)
            ? (currentExtra.skills as Record<string, unknown>)
            : {};
          const allowed = Array.isArray(branch.allowed)
            ? (branch.allowed as string[])
            : [];
          await mergeExtraBranch("skills", {
            allowed: [
              ...allowed.filter((ref) => ref !== created.path),
              created.path,
            ],
          });
        }

        return `skill '${created.name}' saved to library${enable ? " and enabled" : ""}`;
      });
    },
    [agentConfig, createSkill, mergeExtraBranch, proposal, runAction],
  );

  const approveConfigChange = useCallback(async () => {
    if (proposal.kind !== "config_change") return;
    const patch = proposal.payload.patch;
    await runAction(async () => {
      if (!agentConfig) throw new Error("Agent config not loaded yet.");
      const applied: string[] = [];
      const agentBranch = isPlainObject(patch.agent) ? patch.agent : undefined;
      if (agentBranch && typeof agentBranch.system === "string") {
        // The system prompt lives in the flat column (Details edits it there);
        // writing extraConfig.agent.system would shadow that editor forever.
        await updateConfig({
          configId: agentConfigId,
          systemPrompt: agentBranch.system,
        });
        applied.push("system prompt");
      }
      const modelBranch = isPlainObject(patch.model) ? patch.model : undefined;
      if (modelBranch) {
        const { provider, modelId, ...restModel } = modelBranch;
        await updateConfig({
          configId: agentConfigId,
          ...(typeof provider === "string"
            ? { provider: provider as never }
            : {}),
          ...(typeof modelId === "string" ? { modelId: modelId } : {}),
        });
        if (Object.keys(restModel).length > 0) {
          await mergeExtraBranch("model", restModel);
        }
        applied.push("model");
      }
      if (isPlainObject(patch.skills)) {
        await mergeExtraBranch("skills", patch.skills);
        applied.push("skills");
      }
      if (isPlainObject(patch.connectors)) {
        await mergeExtraBranch("connectors", patch.connectors);
        applied.push("connectors");
      }
      if (Array.isArray(patch.workspaces)) {
        await mergeExtraBranch("workspaces", patch.workspaces);
        applied.push("workspaces");
      }
      if (applied.length === 0) {
        throw new Error("The proposed patch touched no applicable field.");
      }

      return `configuration updated (${applied.join(", ")})`;
    });
  }, [
    agentConfig,
    agentConfigId,
    mergeExtraBranch,
    proposal,
    runAction,
    updateConfig,
  ]);

  const approveMcpConnector = useCallback(async () => {
    if (proposal.kind !== "connector" || proposal.payload.kind !== "mcp") {
      return;
    }
    const payload = proposal.payload;
    await runAction(async () => {
      const summary = await createMcp({
        label: payload.label,
        url: payload.url,
      });
      await enableConnector(summary.provider, summary.connectorId);

      return `MCP server '${summary.label}' connected (${summary.toolNames?.length ?? 0} tools) and enabled`;
    });
  }, [createMcp, enableConnector, proposal, runAction]);

  const submitCredentials = useCallback(
    async (provider: string, fields: string[]) => {
      await runAction(async () => {
        const values = Object.fromEntries(
          fields.map((field) => [field, (credentials[field] ?? "").trim()]),
        );
        if (Object.values(values).some((value) => value.length === 0)) {
          throw new Error("Fill in every field first.");
        }
        if (provider === "github") {
          const token = values.token ?? Object.values(values)[0] ?? "";
          const summary = await createToken({
            provider: "github",
            label: "GitHub",
            token: token,
          });
          await enableConnector(summary.provider, summary.connectorId);

          return `github connected${summary.validatedLogin ? ` as ${summary.validatedLogin}` : ""} and enabled`;
        }
        if (CHANNEL_CREDENTIAL_KINDS.has(provider)) {
          if (!agentConfig) throw new Error("Agent config not loaded yet.");
          const currentExtra =
            (agentConfig.extraConfig as Record<string, unknown>) ?? {};
          const channels = isPlainObject(currentExtra.channels)
            ? (currentExtra.channels as Record<string, unknown>)
            : {};
          const current = isPlainObject(channels[provider])
            ? (channels[provider] as Record<string, unknown>)
            : {};
          await mergeExtraBranch("channels", {
            [provider]: { ...current, ...values },
          });

          return `${provider} channel credentials saved`;
        }
        throw new Error(
          `No credential flow for '${provider}' yet — use the Connectors tab.`,
        );
      });
      setCredentials({});
    },
    [
      agentConfig,
      createToken,
      credentials,
      enableConnector,
      mergeExtraBranch,
      runAction,
    ],
  );

  const approveFolder = useCallback(async () => {
    if (proposal.kind !== "context_folder") return;
    const payload = proposal.payload;
    await runAction(async () => {
      const created = await createFolder({
        configId: agentConfigId,
        name: payload.name,
      });

      return `working folder '${payload.name}' created and attached (${created.workspaceId})`;
    });
  }, [agentConfigId, createFolder, proposal, runAction]);

  // ------------------------------------------------------------- rendering

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <p className="text-sm font-medium text-foreground">
          {proposalTitle(proposal)}
        </p>
      </div>

      <ProposalBody proposal={proposal} agentConfig={agentConfig ?? null} />

      {decision?.status === "failed" && (
        <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {decision.detail}
        </p>
      )}

      {settled ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          {decision?.status === "applied" ? (
            <>
              <Check className="size-3 text-green-600" /> Approved —{" "}
              {decision.detail}
            </>
          ) : (
            <>
              <X className="size-3" /> Declined
            </>
          )}
        </p>
      ) : proposal.kind === "credential_request" ? (
        <CredentialForm
          fields={proposal.payload.fields}
          values={credentials}
          onChange={setCredentials}
          busy={busy}
          onSubmit={() => {
            if (proposal.kind !== "credential_request") return;
            void submitCredentials(
              proposal.payload.provider,
              proposal.payload.fields,
            );
          }}
          onDecline={decline}
        />
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {proposal.kind === "skill" ? (
            <>
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={busy || !agentConfig}
                onClick={() => void approveSkill(true)}
              >
                {busy && <Loader2 className="size-3 animate-spin" />}
                Save & enable
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => void approveSkill(false)}
              >
                Save to library
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={busy || !agentConfig}
              onClick={() => {
                if (proposal.kind === "config_change") {
                  void approveConfigChange();
                } else if (proposal.kind === "connector") {
                  if (proposal.payload.kind === "mcp") {
                    void approveMcpConnector();
                  }
                } else if (proposal.kind === "context_folder") {
                  void approveFolder();
                }
              }}
            >
              {busy && <Loader2 className="size-3 animate-spin" />}
              Approve
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-muted-foreground"
            disabled={busy}
            onClick={decline}
          >
            Decline
          </Button>
        </div>
      )}
    </div>
  );
}

/** Kind-specific body content: preview, diff, reason. */
function ProposalBody({
  proposal,
  agentConfig,
}: {
  proposal: SelfConfigProposal;
  agentConfig: FlatAgentConfig | null;
}): React.JSX.Element | null {
  if (proposal.kind === "skill") {
    return (
      <div className="mt-1.5">
        <p className="text-xs text-muted-foreground">
          {proposal.payload.description}
        </p>
        <pre className="mt-1.5 max-h-48 overflow-y-auto overflow-x-auto whitespace-pre-wrap rounded-md border border-border/60 bg-background/50 px-2.5 py-2 font-mono text-[11px] text-foreground">
          {proposal.payload.skillMd}
        </pre>
      </div>
    );
  }

  if (proposal.kind === "config_change") {
    const before = agentConfig
      ? (toNestedAgentConfig(agentConfig) as Record<string, unknown>)
      : {};

    return (
      <div className="mt-1.5">
        <p className="text-xs text-muted-foreground">
          {proposal.payload.reason}
        </p>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {touchedPaths(proposal.payload.patch).map(({ path, next }) => (
            <div
              key={path}
              className="rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5"
            >
              <p className="font-mono text-[11px] font-medium text-foreground">
                {path}
              </p>
              <DiffLine
                label="now"
                value={valueAtPath(before, path)}
                tone="old"
              />
              <DiffLine label="new" value={next} tone="new" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (proposal.kind === "connector") {
    return (
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        {proposal.payload.kind === "mcp"
          ? proposal.payload.url
          : `token connector · ${proposal.payload.provider}`}
      </p>
    );
  }

  if (proposal.kind === "credential_request") {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        {proposal.payload.reason} — the value goes straight to encrypted
        storage; the agent never sees it.
      </p>
    );
  }

  return null;
}

/** Flatten a nested patch into leaf paths for the diff view. */
function touchedPaths(
  patch: Record<string, unknown>,
): Array<{ path: string; next: unknown }> {
  const rows: Array<{ path: string; next: unknown }> = [];
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        rows.push({ path: `${key}.${inner}`, next: innerValue });
      }
    } else {
      rows.push({ path: key, next: value });
    }
  }

  return rows;
}

function valueAtPath(source: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (cursor, segment) =>
        isPlainObject(cursor)
          ? (cursor as Record<string, unknown>)[segment]
          : undefined,
      source,
    );
}

function DiffLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: unknown;
  tone: "old" | "new";
}): React.JSX.Element {
  const text =
    value === undefined
      ? "(not set)"
      : typeof value === "string"
        ? value
        : JSON.stringify(value);

  return (
    <p
      className={`mt-0.5 whitespace-pre-wrap font-mono text-[11px] ${
        tone === "new"
          ? "text-green-600 dark:text-green-500"
          : "text-muted-foreground line-through decoration-muted-foreground/40"
      }`}
    >
      <span className="mr-1 no-underline">{label}:</span>
      {text}
    </p>
  );
}

/**
 * Secure credential form: password inputs, submit straight to the config
 * plane. Values live only in this component's state until submit.
 */
function CredentialForm({
  fields,
  values,
  onChange,
  busy,
  onSubmit,
  onDecline,
}: {
  fields: string[];
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  busy: boolean;
  onSubmit: () => void;
  onDecline: () => void;
}): React.JSX.Element {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {fields.map((field) => (
        <Input
          key={field}
          type="password"
          autoComplete="off"
          placeholder={field}
          value={values[field] ?? ""}
          onChange={(e) => onChange({ ...values, [field]: e.target.value })}
          className="h-7 font-mono text-xs"
        />
      ))}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={busy}
          onClick={onSubmit}
        >
          {busy && <Loader2 className="size-3 animate-spin" />}
          Connect
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-muted-foreground"
          disabled={busy}
          onClick={onDecline}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}
