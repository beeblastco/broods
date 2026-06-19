"use client";

/**
 * Webhooks panel: outbound event webhooks the platform delivers to the user's
 * own services. These are configured per agent (`config.hooks.webhook`) via the
 * SDK/CLI or the agent Config tab — this read-only view surfaces them here so a
 * webhook set up in code is visible in settings instead of only as env vars.
 */
import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { Copy, Eye, EyeOff, Globe } from "lucide-react";
import { useState } from "react";

interface Props {
    /** Project that owns the environment. */
    projectId: Id<"projects">;
    /** Active environment the webhooks are scoped to, or null while none is selected. */
    environmentId: Id<"environments"> | null;
}

type AgentWebhook = {
    agentConfigId: Id<"agentConfigs">;
    agentName: string;
    enabled: boolean;
    url?: string;
    secret?: string;
    events: string[];
};

/** Lists each agent's outbound event webhook (URL, subscribed events, signing secret). */
export function WebhooksPanel({ projectId, environmentId }: Props) {
    const webhooks = useQuery(
        api.webhooks.listAgentWebhooks,
        environmentId ? { projectId: projectId, environmentId: environmentId } : "skip",
    ) as AgentWebhook[] | undefined;

    const [revealedId, setRevealedId] = useState<string | null>(null);

    if (!environmentId) {
        return (
            <Section title="Webhooks" description="Outbound event webhooks delivered to your services.">
                <p className="text-sm text-muted-foreground">Select an environment to view its webhooks.</p>
            </Section>
        );
    }

    return (
        <Section
            title="Webhooks"
            description="Outbound event webhooks delivered to your services. Configure them per agent via the SDK (config.hooks.webhook) or the agent Config tab; secret/URL values resolve from environment variables."
        >
            {webhooks && webhooks.length === 0 && (
                <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                    <Globe className="mx-auto mb-2 size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                        No agent webhooks configured. Add <code>config.hooks.webhook</code> to an agent to deliver events.
                    </p>
                </div>
            )}

            {webhooks?.map((webhook) => (
                <div key={webhook.agentConfigId} className="rounded-lg border border-border bg-card px-4 py-3">
                    <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                                {webhook.url || "(no URL set)"}
                            </span>
                            <Badge variant={webhook.enabled ? "default" : "outline"} className="shrink-0 text-xs">
                                {webhook.enabled ? "Active" : "Inactive"}
                            </Badge>
                        </div>
                        <div className="mb-2 text-xs text-muted-foreground">
                            Agent: <span className="font-medium text-foreground">{webhook.agentName}</span>
                        </div>
                        {webhook.secret && (
                            <div className="mb-2 flex items-center gap-1.5">
                                <code className="font-mono text-xs text-muted-foreground">
                                    {revealedId === webhook.agentConfigId ? webhook.secret : "••••••••••••••••"}
                                </code>
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                                    onClick={() =>
                                        setRevealedId(revealedId === webhook.agentConfigId ? null : webhook.agentConfigId)
                                    }
                                >
                                    {revealedId === webhook.agentConfigId ? (
                                        <EyeOff className="size-3.5" />
                                    ) : (
                                        <Eye className="size-3.5" />
                                    )}
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
                </div>
            ))}
        </Section>
    );
}
