"use client";

/** Webhooks panel: configure endpoints that receive events for the active environment. */
import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Copy, Eye, EyeOff, Globe, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

interface Props {
    /** Project that owns the environment. */
    projectId: Id<"projects">;
    /** Active environment the webhooks are scoped to, or null while none is selected. */
    environmentId: Id<"environments"> | null;
}

const WEBHOOK_EVENTS = [
    "agent.created",
    "agent.updated",
    "agent.deleted",
    "session.started",
    "session.completed",
    "session.failed",
    "environment.created",
    "environment.deleted",
    "api_key.created",
    "api_key.revoked",
] as const;

/** Lists, creates, toggles, rotates secrets for, and deletes the active environment's webhooks. */
export function WebhooksPanel({ projectId, environmentId }: Props) {
    const webhooks = useQuery(
        api.webhooks.list,
        environmentId ? { projectId: projectId, environmentId: environmentId } : "skip",
    ) as Doc<"webhooks">[] | undefined;
    const createWebhook = useMutation(api.webhooks.create);
    const updateWebhook = useMutation(api.webhooks.update);
    const rotateSecret = useMutation(api.webhooks.rotateSecret);
    const removeWebhook = useMutation(api.webhooks.remove);

    const [showAdd, setShowAdd] = useState(false);
    const [newUrl, setNewUrl] = useState("");
    const [newEvents, setNewEvents] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [revealedId, setRevealedId] = useState<string | null>(null);

    async function handleAdd() {
        if (!newUrl.trim() || busy || !environmentId) return;
        setBusy(true);
        try {
            await createWebhook({
                projectId: projectId,
                environmentId: environmentId,
                url: newUrl.trim(),
                events: newEvents,
            });
            setNewUrl("");
            setNewEvents([]);
            setShowAdd(false);
        } finally {
            setBusy(false);
        }
    }

    function toggleEvent(event: string) {
        setNewEvents((prev) =>
            prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
        );
    }

    if (!environmentId) {
        return (
            <Section title="Webhooks" description="Endpoints that receive events for this environment.">
                <p className="text-sm text-muted-foreground">Select an environment to manage its webhooks.</p>
            </Section>
        );
    }

    return (
        <Section title="Webhooks" description="Endpoints that receive events for this environment.">
            {webhooks && webhooks.length === 0 && !showAdd && (
                <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                    <Globe className="mx-auto mb-2 size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                        No webhooks configured. Add one to receive events.
                    </p>
                </div>
            )}

            {webhooks?.map((webhook) => (
                <div key={webhook._id} className="rounded-lg border border-border bg-card px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="mb-1 flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-foreground">{webhook.url}</span>
                                <Badge
                                    variant={webhook.active ? "default" : "outline"}
                                    className="shrink-0 cursor-pointer text-xs"
                                    onClick={() =>
                                        updateWebhook({ webhookId: webhook._id, active: !webhook.active })
                                    }
                                >
                                    {webhook.active ? "Active" : "Inactive"}
                                </Badge>
                            </div>
                            <div className="mb-2 flex items-center gap-1.5">
                                <code className="font-mono text-xs text-muted-foreground">
                                    {revealedId === webhook._id ? webhook.secret : "••••••••••••••••"}
                                </code>
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                                    onClick={() =>
                                        setRevealedId(revealedId === webhook._id ? null : webhook._id)
                                    }
                                >
                                    {revealedId === webhook._id ? (
                                        <EyeOff className="size-3.5" />
                                    ) : (
                                        <Eye className="size-3.5" />
                                    )}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                                    onClick={() => navigator.clipboard.writeText(webhook.secret)}
                                >
                                    <Copy className="size-3.5" />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                                    onClick={() => rotateSecret({ webhookId: webhook._id })}
                                >
                                    <RefreshCw className="size-3.5" />
                                </Button>
                            </div>
                            <div className="flex flex-wrap gap-1">
                                {(webhook.events.length > 0 ? webhook.events : ["all events"]).map((event) => (
                                    <Badge key={event} variant="secondary" className="text-xs">
                                        {event}
                                    </Badge>
                                ))}
                            </div>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
                            onClick={() => removeWebhook({ webhookId: webhook._id })}
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    </div>
                </div>
            ))}

            {showAdd ? (
                <div className="grid gap-4 rounded-lg border border-border bg-card p-4">
                    <div className="grid gap-2">
                        <Label>Webhook URL</Label>
                        <Input
                            value={newUrl}
                            onChange={(e) => setNewUrl(e.target.value)}
                            placeholder="https://your-domain.com/webhook"
                            autoFocus
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label>Events</Label>
                        <div className="grid max-h-48 grid-cols-2 gap-2 overflow-auto">
                            {WEBHOOK_EVENTS.map((event) => (
                                <label key={event} className="flex cursor-pointer items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={newEvents.includes(event)}
                                        onChange={() => toggleEvent(event)}
                                        className="size-4 cursor-pointer rounded border-border bg-background text-primary focus:ring-2 focus:ring-ring"
                                    />
                                    <span className="text-muted-foreground">{event}</span>
                                </label>
                            ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {newEvents.length === 0
                                ? "All events selected by default"
                                : `${newEvents.length} events selected`}
                        </p>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="cursor-pointer"
                            onClick={() => {
                                setShowAdd(false);
                                setNewUrl("");
                                setNewEvents([]);
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            className="cursor-pointer disabled:cursor-not-allowed"
                            onClick={handleAdd}
                            disabled={!newUrl.trim() || busy}
                        >
                            <Plus className="mr-1 size-4" />
                            {busy ? "Adding…" : "Add Webhook"}
                        </Button>
                    </div>
                </div>
            ) : (
                <Button
                    variant="outline"
                    size="sm"
                    className="w-fit cursor-pointer"
                    onClick={() => setShowAdd(true)}
                >
                    <Plus className="mr-1 size-4" />
                    Add Webhook
                </Button>
            )}
        </Section>
    );
}
