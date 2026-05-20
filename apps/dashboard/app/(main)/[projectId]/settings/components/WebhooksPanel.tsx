"use client";

/** Webhooks panel: configure endpoints that receive project events. */
import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import type { Id } from "@/convex/_generated/dataModel";
import { Copy, Eye, EyeOff, Globe, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

interface Props {
    /** Project this settings panel belongs to. */
    projectId: Id<"projects">;
}

interface WebhookEntry {
    id: string;
    url: string;
    secret: string;
    events: string[];
    active: boolean;
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

function generateSecret() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function WebhooksPanel({ projectId: _projectId }: Props) {
    const [webhooks, setWebhooks] = useState<WebhookEntry[]>([]);
    const [showAddWebhook, setShowAddWebhook] = useState(false);
    const [newWebhookUrl, setNewWebhookUrl] = useState("");
    const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>([]);
    const [showKey, setShowKey] = useState<string | null>(null);

    function handleAddWebhook() {
        if (!newWebhookUrl.trim()) return;
        setWebhooks((prev) => [
            ...prev,
            {
                id: Date.now().toString(),
                url: newWebhookUrl.trim(),
                secret: generateSecret(),
                events: newWebhookEvents.length > 0 ? newWebhookEvents : [...WEBHOOK_EVENTS],
                active: true,
            },
        ]);
        setNewWebhookUrl("");
        setNewWebhookEvents([]);
        setShowAddWebhook(false);
    }

    function handleDeleteWebhook(id: string) {
        setWebhooks((prev) => prev.filter((w) => w.id !== id));
    }

    function toggleWebhookEvent(event: string) {
        setNewWebhookEvents((prev) =>
            prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
        );
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text);
    }

    return (
        <div className="grid gap-4">
            {webhooks.length === 0 && (
                <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                    <Globe className="size-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">No webhooks configured. Add one to receive events.</p>
                </div>
            )}
            {webhooks.map((webhook) => (
                <div key={webhook.id} className="rounded-lg border border-border bg-card px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-sm font-medium text-foreground truncate">{webhook.url}</span>
                                <Badge variant={webhook.active ? "default" : "outline"} className="text-xs shrink-0">
                                    {webhook.active ? "Active" : "Inactive"}
                                </Badge>
                            </div>
                            <div className="flex items-center gap-1.5 mb-2">
                                <code className="font-mono text-xs text-muted-foreground">
                                    {showKey === `wh-${webhook.id}` ? webhook.secret : "••••••••••••••••"}
                                </code>
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                                    onClick={() => setShowKey(showKey === `wh-${webhook.id}` ? null : `wh-${webhook.id}`)}
                                >
                                    {showKey === `wh-${webhook.id}` ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                                    onClick={() => copyToClipboard(webhook.secret)}
                                >
                                    <Copy className="size-3.5" />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                                    onClick={() => {
                                        setWebhooks((prev) =>
                                            prev.map((w) =>
                                                w.id === webhook.id ? { ...w, secret: generateSecret() } : w,
                                            ),
                                        );
                                    }}
                                >
                                    <RefreshCw className="size-3.5" />
                                </Button>
                            </div>
                            <div className="flex flex-wrap gap-1">
                                {webhook.events.map((event) => (
                                    <Badge key={event} variant="secondary" className="text-xs">
                                        {event}
                                    </Badge>
                                ))}
                            </div>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive shrink-0"
                            onClick={() => handleDeleteWebhook(webhook.id)}
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    </div>
                </div>
            ))}
            {showAddWebhook ? (
                <div className="rounded-lg border border-border bg-card p-4 grid gap-4">
                    <div className="grid gap-2">
                        <Label>Webhook URL</Label>
                        <Input
                            value={newWebhookUrl}
                            onChange={(e) => setNewWebhookUrl(e.target.value)}
                            placeholder="https://your-domain.com/webhook"
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label>Events</Label>
                        <div className="grid grid-cols-2 gap-2 max-h-48 overflow-auto">
                            {WEBHOOK_EVENTS.map((event) => (
                                <label key={event} className="flex items-center gap-2 text-sm cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={newWebhookEvents.includes(event)}
                                        onChange={() => toggleWebhookEvent(event)}
                                        className="size-4 rounded border-border bg-background text-primary focus:ring-2 focus:ring-ring cursor-pointer"
                                    />
                                    <span className="text-muted-foreground">{event}</span>
                                </label>
                            ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {newWebhookEvents.length === 0 ? "All events selected by default" : `${newWebhookEvents.length} events selected`}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 justify-end">
                        <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => setShowAddWebhook(false)}>
                            Cancel
                        </Button>
                        <Button size="sm" className="cursor-pointer" onClick={handleAddWebhook} disabled={!newWebhookUrl.trim()}>
                            <Plus className="size-4 mr-1" />Add Webhook
                        </Button>
                    </div>
                </div>
            ) : (
                <Button variant="outline" size="sm" className="cursor-pointer w-fit" onClick={() => setShowAddWebhook(true)}>
                    <Plus className="size-4 mr-1" />Add Webhook
                </Button>
            )}
        </div>
    );
}
