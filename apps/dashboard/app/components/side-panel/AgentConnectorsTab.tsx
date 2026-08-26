"use client";

/**
 * Connectors tab (ticket 20): Manage (channels + connectors with real
 * status each) and Browse/Add. Channel cards validate with one real API
 * call and show the webhook URL to paste at the provider; connector cards
 * show the row's true status, the per-agent enable toggle
 * (`connectors.allowed`, merge-safe), check, and remove. Everything shown
 * is the truth from the `connectors` table and `config.channels`.
 */

import { ChannelsSection } from "@/app/components/side-panel/ChannelsSection";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Separator } from "@/app/components/ui/separator";
import { Switch } from "@/app/components/ui/switch";
import {
  readAgentBranch,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Check,
  Copy,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface ConnectorSummary {
  connectorId: Id<"connectors">;
  provider: string;
  label: string;
  authKind: "token" | "mcp";
  url?: string;
  status: "connected" | "error";
  lastCheckedAt?: number;
  lastError?: string;
  toolNames?: string[];
  validatedLogin?: string;
}

interface ConnectorRef {
  provider: string;
  connectorId: string;
  enabled: boolean;
}

interface ConnectorsBranch extends Record<string, unknown> {
  allowed?: ConnectorRef[];
}

const WEBHOOK_HINTS: Record<string, string> = {
  telegram:
    "Paste at Telegram: call setWebhook with this URL (and your webhook secret as secret_token).",
  slack:
    "Paste as the Request URL under Event Subscriptions in your Slack app.",
  discord:
    "Paste as the Interactions Endpoint URL in your Discord application.",
  github: "Paste as the Webhook URL in your GitHub App settings.",
  pancake: "Paste as the webhook URL in your Pancake page settings.",
  zalo: "Paste as the webhook URL in your Zalo bot settings.",
};

export function AgentConnectorsTab({
  agentConfig,
  onUpdateChannelConfig,
}: {
  agentConfig: Doc<"agentConfigs"> | null | undefined;
  onUpdateChannelConfig?: (
    kind: string,
    config: Record<string, unknown> | null,
  ) => Promise<void>;
}): React.JSX.Element {
  const listConnectors = useAction(api.connectorsPublic.listConnectors);
  const checkConnector = useAction(api.connectorsPublic.checkConnector);
  const deleteConnector = useAction(api.connectorsPublic.deleteConnector);
  const updateConfig = useMutation(api.agentConfig.update);
  const activeAccount = useQuery(api.org.getActiveAccount, {});

  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | "mcp" | "github">(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await listConnectors({});
      setConnectors(rows);
      setLoadError(null);
    } catch (err) {
      setLoadError(toErrorMessage(err));
    }
  }, [listConnectors]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const allowed = useMemo(() => {
    const branch = readAgentBranch<ConnectorsBranch>(
      agentConfig as FlatAgentConfig | undefined,
      "connectors",
    );

    return Array.isArray(branch.allowed) ? branch.allowed : [];
  }, [agentConfig]);

  /** Merge-safe write of connectors.allowed — never clobbers other branches. */
  const saveAllowed = useCallback(
    async (nextAllowed: ConnectorRef[]) => {
      if (!agentConfig) return;
      const currentExtra =
        (agentConfig.extraConfig as Record<string, unknown>) ?? {};
      const currentBranch =
        (currentExtra.connectors as Record<string, unknown>) ?? {};
      await updateConfig({
        configId: agentConfig._id,
        extraConfig: {
          ...currentExtra,
          connectors: { ...currentBranch, allowed: nextAllowed },
        },
      });
    },
    [agentConfig, updateConfig],
  );

  const refFor = useCallback(
    (connectorId: string) =>
      allowed.find((ref) => ref.connectorId === connectorId),
    [allowed],
  );

  const toggleConnector = useCallback(
    async (connector: ConnectorSummary, enabled: boolean) => {
      const rest = allowed.filter(
        (ref) => ref.connectorId !== connector.connectorId,
      );
      await saveAllowed([
        ...rest,
        {
          provider: connector.provider,
          connectorId: connector.connectorId,
          enabled: enabled,
        },
      ]);
    },
    [allowed, saveAllowed],
  );

  async function handleRemove(connector: ConnectorSummary) {
    setBusyId(connector.connectorId);
    setConfirmRemoveId(null);
    try {
      await deleteConnector({ connectorId: connector.connectorId });
      await saveAllowed(
        allowed.filter((ref) => ref.connectorId !== connector.connectorId),
      );
      await reload();
    } catch (err) {
      setLoadError(toErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleCheck(connector: ConnectorSummary) {
    setBusyId(connector.connectorId);
    try {
      await checkConnector({ connectorId: connector.connectorId });
      await reload();
    } catch (err) {
      setLoadError(toErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-5 p-4">
      {/* ------------ Manage: connectors ------------ */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Connectors
          </span>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => setAdding(adding === "github" ? null : "github")}
            >
              <Plus className="size-3" />
              GitHub
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => setAdding(adding === "mcp" ? null : "mcp")}
            >
              <Plus className="size-3" />
              Custom MCP
            </Button>
          </div>
        </div>

        {loadError && (
          <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            {loadError}
          </p>
        )}

        {adding && (
          <AddConnectorForm
            kind={adding}
            onDone={() => {
              setAdding(null);
              void reload();
            }}
            onCancel={() => setAdding(null)}
          />
        )}

        {connectors === null && !loadError && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {connectors !== null && connectors.length === 0 && !adding && (
          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/30 px-3 py-4">
            <Plug className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              No connectors yet. Connect GitHub with a token, or add any MCP
              server by URL — the agent gains its tools immediately.
            </p>
          </div>
        )}

        {(connectors ?? []).map((connector) => {
          const ref = refFor(connector.connectorId);
          const enabled = ref?.enabled === true;

          return (
            <div
              key={connector.connectorId}
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <Plug className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                  {connector.label}
                </span>
                <span
                  className={`shrink-0 text-[10px] font-medium ${
                    connector.status === "connected"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-red-600 dark:text-red-400"
                  }`}
                >
                  {connector.status === "connected"
                    ? connector.validatedLogin
                      ? `connected as ${connector.validatedLogin}`
                      : "connected"
                    : "error"}
                </span>
                <Switch
                  checked={enabled}
                  onCheckedChange={(next) =>
                    void toggleConnector(connector, next)
                  }
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {connector.authKind === "mcp"
                  ? `${connector.url ?? ""}${
                      connector.toolNames?.length
                        ? ` — ${connector.toolNames.length} tools: ${connector.toolNames.slice(0, 6).join(", ")}${connector.toolNames.length > 6 ? ", …" : ""}`
                        : ""
                    }`
                  : "GitHub REST API access with your token"}
              </p>
              {connector.status === "error" && connector.lastError && (
                <p className="rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-400">
                  {connector.lastError}
                  {connector.lastCheckedAt
                    ? ` (since ${new Date(connector.lastCheckedAt).toLocaleTimeString()})`
                    : ""}
                </p>
              )}
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
                  disabled={busyId === connector.connectorId}
                  onClick={() => void handleCheck(connector)}
                >
                  {busyId === connector.connectorId ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  Check
                </Button>
                <span className="flex-1" />
                {confirmRemoveId === connector.connectorId ? (
                  <>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => void handleRemove(connector)}
                    >
                      Remove?
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="size-6"
                      onClick={() => setConfirmRemoveId(null)}
                    >
                      <X className="size-3" />
                    </Button>
                  </>
                ) : (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 text-muted-foreground hover:text-red-500"
                    title="Remove connector"
                    onClick={() => setConfirmRemoveId(connector.connectorId)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}

        {/* Browse: what's coming */}
        <div className="flex items-start gap-2.5 rounded-lg border border-dashed border-border bg-muted/10 px-3 py-2.5">
          <Plug className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col">
            <span className="text-xs font-medium text-muted-foreground">
              Google Drive — coming soon
            </span>
            <span className="text-[11px] text-muted-foreground">
              Not available yet; it needs a Google sign-in flow we haven&apos;t
              shipped.
            </span>
          </div>
        </div>
      </div>

      <Separator />

      {/* ------------ Manage: channels ------------ */}
      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Channels
        </span>
        <p className="text-[11px] text-muted-foreground">
          Places people can message this agent. Each configured channel is
          verified with a real call and shows the webhook URL to paste at the
          provider.
        </p>
      </div>

      {agentConfig && (
        <ChannelStatusCards
          agentConfig={agentConfig}
          accountId={activeAccount?.accountId ?? null}
        />
      )}

      {agentConfig && onUpdateChannelConfig ? (
        <ChannelsSection
          agentConfig={agentConfig}
          onUpdateChannel={onUpdateChannelConfig}
        />
      ) : (
        <p className="text-xs text-muted-foreground">Loading channels…</p>
      )}
    </div>
  );
}

/** Live verification + webhook URL for each configured channel. */
function ChannelStatusCards({
  agentConfig,
  accountId,
}: {
  agentConfig: Doc<"agentConfigs">;
  accountId: string | null;
}) {
  const validateChannel = useAction(api.channelsPublic.validateChannel);
  const [results, setResults] = useState<
    Record<string, { status: "ok" | "error" | "unverified"; detail: string }>
  >({});
  const [copied, setCopied] = useState<string | null>(null);

  const channels = useMemo(
    () =>
      readAgentBranch<Record<string, Record<string, unknown>>>(
        agentConfig as unknown as FlatAgentConfig,
        "channels",
      ),
    [agentConfig],
  );
  const configuredKinds = Object.keys(channels);
  // Re-validate when the saved channel configs change (validate-on-save:
  // ChannelsSection saves flow back through agentConfig reactively).
  const channelsFingerprint = JSON.stringify(channels);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const kinds = Object.keys(
        JSON.parse(channelsFingerprint) as Record<string, unknown>,
      );
      for (const kind of kinds) {
        try {
          const config = (
            JSON.parse(channelsFingerprint) as Record<
              string,
              Record<string, unknown>
            >
          )[kind];
          const result = await validateChannel({
            kind: kind,
            config: config ?? {},
          });
          if (!cancelled) {
            setResults((prev) => ({ ...prev, [kind]: result }));
          }
        } catch (err) {
          if (!cancelled) {
            setResults((prev) => ({
              ...prev,
              [kind]: { status: "error", detail: toErrorMessage(err) },
            }));
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [channelsFingerprint, validateChannel]);

  const coreEndpoint = resolveCoreEndpoint();
  if (configuredKinds.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {configuredKinds.map((kind) => {
        const result = results[kind];
        const webhookUrl =
          coreEndpoint.ok && accountId
            ? `${coreEndpoint.httpBaseUrl}/webhooks/${accountId}/${kind}`
            : null;

        return (
          <div
            key={kind}
            className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 text-xs font-medium capitalize text-foreground">
                {kind}
              </span>
              <span
                className={`text-[10px] font-medium ${
                  result?.status === "ok"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : result?.status === "error"
                      ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground"
                }`}
              >
                {result?.status === "ok"
                  ? result.detail
                  : result?.status === "error"
                    ? "not working"
                    : (result?.detail ?? "verifying…")}
              </span>
            </div>
            {result?.status === "error" && (
              <p className="rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-400">
                {result.detail}
              </p>
            )}
            {webhookUrl && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2 py-1">
                  <code className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                    {webhookUrl}
                  </code>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 shrink-0 text-muted-foreground"
                    onClick={() => {
                      void navigator.clipboard.writeText(webhookUrl);
                      setCopied(kind);
                      setTimeout(() => setCopied(null), 1500);
                    }}
                  >
                    {copied === kind ? (
                      <Check className="size-3" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                  </Button>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {WEBHOOK_HINTS[kind] ??
                    "Paste this webhook URL at the provider."}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Add flows: Custom MCP (label/url/headers) and GitHub token. */
function AddConnectorForm({
  kind,
  onDone,
  onCancel,
}: {
  kind: "mcp" | "github";
  onDone: () => void;
  onCancel: () => void;
}) {
  const createTokenConnector = useAction(
    api.connectorsPublic.createTokenConnector,
  );
  const createCustomMcpConnector = useAction(
    api.connectorsPublic.createCustomMcpConnector,
  );

  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdToolNames, setCreatedToolNames] = useState<string[] | null>(
    null,
  );

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (kind === "github") {
        await createTokenConnector({
          provider: "github",
          label: label.trim() || "GitHub",
          token: token.trim(),
        });
        onDone();
      } else {
        const headers: Record<string, string> = {};
        for (const line of headersText.split("\n")) {
          const separator = line.indexOf(":");
          if (separator > 0) {
            headers[line.slice(0, separator).trim()] = line
              .slice(separator + 1)
              .trim();
          }
        }
        const created = await createCustomMcpConnector({
          label: label.trim() || "MCP server",
          url: url.trim(),
          ...(Object.keys(headers).length > 0 ? { headers: headers } : {}),
        });
        setCreatedToolNames(created.toolNames ?? []);
        setTimeout(onDone, 1200);
      }
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
      <span className="text-xs font-medium text-foreground">
        {kind === "github" ? "Connect GitHub" : "Add a custom MCP server"}
      </span>
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={
          kind === "github" ? "Label (e.g. GitHub)" : "Label (e.g. weather)"
        }
        className="h-7 text-xs"
      />
      {kind === "github" ? (
        <Input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          placeholder="Personal access token (ghp_… / github_pat_…)"
          className="h-7 font-mono text-xs"
        />
      ) : (
        <>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://server.example/mcp"
            className="h-7 font-mono text-xs"
          />
          <Input
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            placeholder="Optional headers, one per line: Authorization: Bearer …"
            className="h-7 font-mono text-xs"
          />
        </>
      )}
      {error && (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </p>
      )}
      {createdToolNames && (
        <p className="rounded-md bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          Connected — {createdToolNames.length} tools:{" "}
          {createdToolNames.slice(0, 8).join(", ")}
          {createdToolNames.length > 8 ? ", …" : ""}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          disabled={busy || (kind === "github" ? !token.trim() : !url.trim())}
          onClick={() => void submit()}
        >
          {busy && <Loader2 className="mr-1 size-3 animate-spin" />}
          {kind === "github" ? "Connect" : "Add server"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2.5 text-[11px]"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
