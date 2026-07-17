"use client";

/**
 * Webhooks panel: outbound event webhooks the platform delivers to the user's own
 * services. Each agent can register several (`config.hooks.webhooks`); this panel
 * lists them per agent and lets you add one, toggle it active/inactive, or remove
 * it. Edits write straight to the agent config the harness delivers from.
 */
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { DitherAvatarSVG } from "@/app/components/DitherAvatar";
import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Copy, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

interface Props {
  /** Project that owns the environment. */
  projectId: Id<"projects">;
  /** Active environment the webhooks are scoped to, or null while none is selected. */
  environmentId: Id<"environments"> | null;
}

type AgentWebhooks = {
  agentConfigId: Id<"agentConfigs">;
  agentName: string;
  webhooks: Array<{
    index: number;
    enabled: boolean;
    url?: string;
    secret?: string;
    events: string[];
  }>;
};

type PendingWebhookDelete = {
  agentConfigId: Id<"agentConfigs">;
  index: number;
  url: string;
};

/** Lists each agent's outbound webhooks with add / activate / remove controls. */
export function WebhooksPanel({ projectId, environmentId }: Props) {
  const agents = useQuery(
    api.webhooks.listAgentWebhooks,
    environmentId
      ? { projectId: projectId, environmentId: environmentId }
      : "skip",
  ) as AgentWebhooks[] | undefined;

  const setEnabled = useMutation(api.webhooks.setAgentWebhookEnabled);
  const removeWebhook = useMutation(api.webhooks.removeAgentWebhook);

  // `${agentConfigId}:${index}` of the webhook whose secret is currently revealed.
  const [revealed, setRevealed] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<Id<"agentConfigs"> | null>(null);

  // Webhook pending delete confirmation.
  const [deletingWebhook, setDeletingWebhook] =
    useState<PendingWebhookDelete | null>(null);
  const [isDeletingWebhook, setIsDeletingWebhook] = useState(false);

  async function handleDeleteWebhook() {
    if (!deletingWebhook) return;
    setIsDeletingWebhook(true);
    try {
      await removeWebhook({
        agentConfigId: deletingWebhook.agentConfigId,
        index: deletingWebhook.index,
      });
      setDeletingWebhook(null);
    } finally {
      setIsDeletingWebhook(false);
    }
  }

  if (!environmentId) {
    return (
      <Section description="Outbound event webhooks delivered to your services.">
        <p className="text-sm text-muted-foreground">
          Select an environment to view its webhooks.
        </p>
      </Section>
    );
  }

  return (
    <>
      <Section description="Outbound event webhooks delivered to your services. Each agent can register several — add one, toggle it active/inactive, or remove it. (Webhooks defined in code via the SDK resolve their URL/secret from environment variables.)">
        {agents && agents.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No agents in this environment yet.
          </p>
        )}

        <div className="grid gap-6">
          {agents?.map((agent) => (
            <div key={agent.agentConfigId} className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <DitherAvatarSVG
                    seed={agent.agentName}
                    size={20}
                    className="shrink-0"
                  />
                  <span className="truncate text-sm font-medium text-foreground">
                    {agent.agentName}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 cursor-pointer gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setAddingFor(
                      addingFor === agent.agentConfigId
                        ? null
                        : agent.agentConfigId,
                    )
                  }
                >
                  <Plus className="size-3.5" />
                  Add webhook
                </Button>
              </div>

              {agent.webhooks.length === 0 &&
                addingFor !== agent.agentConfigId && (
                  <p className="text-xs text-muted-foreground">
                    No webhooks configured.
                  </p>
                )}

              {agent.webhooks.map((webhook) => {
                const key = `${agent.agentConfigId}:${webhook.index}`;

                return (
                  <div
                    key={key}
                    className="grid gap-1.5 border-t border-border/60 pt-2 first:border-t-0 first:pt-0"
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {webhook.url || "(no URL set)"}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setEnabled({
                            agentConfigId: agent.agentConfigId,
                            index: webhook.index,
                            enabled: !webhook.enabled,
                          })
                        }
                        className={cn(
                          "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                          webhook.enabled
                            ? "bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25"
                            : "bg-red-500/15 text-red-600 hover:bg-red-500/25",
                        )}
                        title={
                          webhook.enabled
                            ? "Active — click to disable"
                            : "Inactive — click to enable"
                        }
                      >
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            webhook.enabled ? "bg-emerald-500" : "bg-red-500",
                          )}
                        />
                        {webhook.enabled ? "Active" : "Inactive"}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          setDeletingWebhook({
                            agentConfigId: agent.agentConfigId,
                            index: webhook.index,
                            url: webhook.url ?? "webhook",
                          })
                        }
                        title="Remove webhook"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>

                    {webhook.secret && (
                      <div className="flex items-center gap-1.5">
                        <code className="font-mono text-xs text-muted-foreground">
                          {revealed === key
                            ? webhook.secret
                            : "••••••••••••••••"}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="cursor-pointer text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            setRevealed(revealed === key ? null : key)
                          }
                        >
                          {revealed === key ? (
                            <EyeOff className="size-3.5" />
                          ) : (
                            <Eye className="size-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="cursor-pointer text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            navigator.clipboard.writeText(webhook.secret ?? "")
                          }
                        >
                          <Copy className="size-3.5" />
                        </Button>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-1">
                      {(webhook.events.length > 0
                        ? webhook.events
                        : ["all events"]
                      ).map((event) => (
                        <Badge
                          key={event}
                          variant="secondary"
                          className="text-xs"
                        >
                          {event}
                        </Badge>
                      ))}
                    </div>
                  </div>
                );
              })}

              {addingFor === agent.agentConfigId && (
                <AddWebhookForm
                  agentConfigId={agent.agentConfigId}
                  onDone={() => setAddingFor(null)}
                />
              )}
            </div>
          ))}
        </div>
      </Section>

      {deletingWebhook && (
        <DeleteConfirmDialog
          open={deletingWebhook !== null}
          onOpenChange={(open) => {
            if (!open) setDeletingWebhook(null);
          }}
          resourceName={deletingWebhook.url}
          resourceType="webhook"
          critical={false}
          onConfirm={handleDeleteWebhook}
          isDeleting={isDeletingWebhook}
        />
      )}
    </>
  );
}

/** Inline form to add an outbound webhook (URL, signing secret, optional event filter) to an agent. */
function AddWebhookForm({
  agentConfigId,
  onDone,
}: {
  agentConfigId: Id<"agentConfigs">;
  onDone: () => void;
}) {
  const addWebhook = useMutation(api.webhooks.addAgentWebhook);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!url.trim() || !secret.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addWebhook({
        agentConfigId: agentConfigId,
        url: url.trim(),
        secret: secret.trim(),
        events: events
          .split(",")
          .map((event) => event.trim())
          .filter(Boolean),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add webhook");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 border-t border-border/60 pt-2">
      <Input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://your-service.example/hooks"
        className="text-sm"
        autoFocus
      />
      <Input
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder="HMAC signing secret"
        className="text-sm"
      />
      <Input
        value={events}
        onChange={(e) => setEvents(e.target.value)}
        placeholder="Events, comma-separated (blank = all, e.g. agent.started, agent.finished)"
        className="text-sm"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="cursor-pointer disabled:cursor-not-allowed"
          disabled={!url.trim() || !secret.trim() || busy}
          onClick={handleSave}
        >
          {busy ? "Adding…" : "Add webhook"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="cursor-pointer"
          onClick={onDone}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
