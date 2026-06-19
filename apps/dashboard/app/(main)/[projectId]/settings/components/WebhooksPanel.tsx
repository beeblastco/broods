"use client";

/**
 * Webhooks panel: outbound event webhooks the platform delivers to the user's own
 * services. Each agent can register several (`config.hooks.webhooks`); this panel
 * lists them per agent and lets you add one, toggle it active/inactive, or remove
 * it. Edits write straight to the agent config the harness delivers from.
 */
import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Copy, Eye, EyeOff, Globe, Plus, Trash2 } from "lucide-react";
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

/** Lists each agent's outbound webhooks with add / activate / remove controls. */
export function WebhooksPanel({ projectId, environmentId }: Props) {
    const agents = useQuery(
        api.webhooks.listAgentWebhooks,
        environmentId ? { projectId: projectId, environmentId: environmentId } : "skip",
    ) as AgentWebhooks[] | undefined;

    const setEnabled = useMutation(api.webhooks.setAgentWebhookEnabled);
    const removeWebhook = useMutation(api.webhooks.removeAgentWebhook);

    // `${agentConfigId}:${index}` of the webhook whose secret is currently revealed.
    const [revealed, setRevealed] = useState<string | null>(null);
    const [addingFor, setAddingFor] = useState<Id<"agentConfigs"> | null>(null);

    if (!environmentId) {
        return (
            <Section description="Outbound event webhooks delivered to your services.">
                <p className="text-sm text-muted-foreground">Select an environment to view its webhooks.</p>
            </Section>
        );
    }

    return (
        <Section description="Outbound event webhooks delivered to your services. Each agent can register several — add one, toggle it active/inactive, or remove it. (Webhooks defined in code via the SDK resolve their URL/secret from environment variables.)">
            {agents && agents.length === 0 && (
                <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                    <Globe className="mx-auto mb-2 size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">No agents in this environment yet.</p>
                </div>
            )}

            {agents?.map((agent) => (
                <div key={agent.agentConfigId} className="rounded-lg border border-border bg-card px-4 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{agent.agentName}</span>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 cursor-pointer gap-1 text-muted-foreground hover:text-foreground"
                            onClick={() => setAddingFor(addingFor === agent.agentConfigId ? null : agent.agentConfigId)}
                        >
                            <Plus className="size-3.5" />
                            Add webhook
                        </Button>
                    </div>

                    {agent.webhooks.length === 0 && addingFor !== agent.agentConfigId && (
                        <p className="text-xs text-muted-foreground">No webhooks configured for this agent.</p>
                    )}

                    <div className="flex flex-col gap-2">
                        {agent.webhooks.map((webhook) => {
                            const key = `${agent.agentConfigId}:${webhook.index}`;

                            return (
                                <div key={key} className="rounded-md border border-border/70 bg-background/40 px-3 py-2">
                                    <div className="mb-1.5 flex items-center gap-2">
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
                                            title={webhook.enabled ? "Active — click to disable" : "Inactive — click to enable"}
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
                                                removeWebhook({ agentConfigId: agent.agentConfigId, index: webhook.index })
                                            }
                                            title="Remove webhook"
                                        >
                                            <Trash2 className="size-3.5" />
                                        </Button>
                                    </div>

                                    {webhook.secret && (
                                        <div className="mb-1.5 flex items-center gap-1.5">
                                            <code className="font-mono text-xs text-muted-foreground">
                                                {revealed === key ? webhook.secret : "••••••••••••••••"}
                                            </code>
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                className="cursor-pointer text-muted-foreground hover:text-foreground"
                                                onClick={() => setRevealed(revealed === key ? null : key)}
                                            >
                                                {revealed === key ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                className="cursor-pointer text-muted-foreground hover:text-foreground"
                                                onClick={() => navigator.clipboard.writeText(webhook.secret ?? "")}
                                            >
                                                <Copy className="size-3.5" />
                                            </Button>
                                        </div>
                                    )}

                                    <div className="flex flex-wrap gap-1">
                                        {(webhook.events.length > 0 ? webhook.events : ["all events"]).map((event) => (
                                            <Badge key={event} variant="secondary" className="text-xs">
                                                {event}
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {addingFor === agent.agentConfigId && (
                        <AddWebhookForm
                            agentConfigId={agent.agentConfigId}
                            onDone={() => setAddingFor(null)}
                        />
                    )}
                </div>
            ))}
        </Section>
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
        <div className="mt-2 grid gap-2 rounded-md border border-dashed border-border bg-background/40 p-3">
            <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-service.example/hooks"
                className="text-xs"
            />
            <Input
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="HMAC signing secret"
                className="text-xs"
            />
            <Input
                value={events}
                onChange={(e) => setEvents(e.target.value)}
                placeholder="Events, comma-separated (blank = all, e.g. agent.started, agent.finished)"
                className="text-xs"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    className="cursor-pointer"
                    disabled={!url.trim() || !secret.trim() || busy}
                    onClick={handleSave}
                >
                    {busy ? "Adding…" : "Add"}
                </Button>
                <Button variant="ghost" size="sm" className="cursor-pointer" onClick={onDone}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}
