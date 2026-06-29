"use client";

/**
 * Agent Details-tab channels editor. Channels are inbound webhook triggers the agent replies
 * to; this renders a schema-driven form for the six broods channel kinds so adding a
 * field/kind is a data change, not new UI. Secrets accept `${ENV}` placeholders.
 */
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { SectionHeader } from "@/app/components/side-panel/SectionHeader";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { readAgentBranch, type FlatAgentConfig } from "@/app/lib/agentConfigCodec";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

/** How a single channel field is entered and serialized. */
type FieldType = "text" | "secret" | "stringList" | "numberList";

type ChannelField = {
    key: string;
    label: string;
    type: FieldType;
    required?: boolean;
    placeholder?: string;
    /** Nested location in the channel config; defaults to `[key]`. */
    path?: string[];
};

type ChannelKind = { kind: string; label: string; fields: ChannelField[] };

/** The six broods channel kinds and their config fields (source of truth: agent-config.ts). */
const CHANNELS: ChannelKind[] = [
    {
        kind: "telegram",
        label: "Telegram",
        fields: [
            { key: "botToken", label: "Bot token", type: "secret", required: true },
            { key: "webhookSecret", label: "Webhook secret", type: "secret", required: true },
            { key: "allowedChatIds", label: "Allowed chat IDs", type: "numberList", placeholder: "123456789, …" },
            { key: "reactionEmoji", label: "Reaction emoji", type: "text", placeholder: "👀" },
            { key: "apiUrl", label: "API URL", type: "text", placeholder: "https://api.telegram.org" },
        ],
    },
    {
        kind: "github",
        label: "GitHub",
        fields: [
            { key: "webhookSecret", label: "Webhook secret", type: "secret", required: true },
            { key: "appId", label: "App ID", type: "text", required: true },
            { key: "privateKey", label: "Private key", type: "secret", required: true },
            { key: "allowedRepos", label: "Allowed repos", type: "stringList", placeholder: "owner/repo, …" },
            { key: "apiUrl", label: "API URL", type: "text", placeholder: "https://api.github.com" },
        ],
    },
    {
        kind: "slack",
        label: "Slack",
        fields: [
            { key: "botToken", label: "Bot token", type: "secret", required: true },
            { key: "signingSecret", label: "Signing secret", type: "secret", required: true },
            { key: "allowedChannelIds", label: "Allowed channel IDs", type: "stringList", placeholder: "C123, …" },
            { key: "reactionEmoji", label: "Reaction emoji", type: "text", placeholder: "eyes" },
            { key: "apiUrl", label: "API URL", type: "text", placeholder: "https://slack.com/api/" },
        ],
    },
    {
        kind: "discord",
        label: "Discord",
        fields: [
            { key: "botToken", label: "Bot token", type: "secret", required: true },
            { key: "publicKey", label: "Public key", type: "text", required: true },
            { key: "allowedGuildIds", label: "Allowed guild IDs", type: "stringList", placeholder: "123, …" },
            { key: "apiUrl", label: "API URL", type: "text", placeholder: "https://discord.com/api/v10" },
        ],
    },
    {
        kind: "pancake",
        label: "Pancake",
        fields: [
            { key: "pageId", label: "Page ID", type: "text", required: true },
            { key: "pageAccessToken", label: "Page access token", type: "secret", required: true },
            { key: "senderId", label: "Sender ID", type: "text" },
            { key: "ignoreTagIds", label: "Ignore tag IDs", type: "stringList", path: ["options", "ignoreTagIds"], placeholder: "order-tag, …" },
        ],
    },
    {
        kind: "zalo",
        label: "Zalo",
        fields: [
            { key: "botToken", label: "Bot token", type: "secret", required: true },
            { key: "webhookSecret", label: "Webhook secret (8–256 chars)", type: "secret", required: true },
            { key: "allowedUserIds", label: "Allowed user IDs", type: "stringList", placeholder: "123456789, …" },
        ],
    },
];

type ChannelConfig = Record<string, unknown>;

/** Read a (possibly nested) value from a channel config. */
function readAt(config: ChannelConfig, path: string[]): unknown {
    return path.reduce<unknown>((cursor, key) => (cursor as ChannelConfig | undefined)?.[key], config);
}

/** Immutably set or delete a (possibly nested) value, pruning empty branches on delete. */
function writeAt(config: ChannelConfig, path: string[], value: unknown): ChannelConfig {
    const [head, ...rest] = path;
    const next = { ...config };
    if (rest.length === 0) {
        if (value === undefined) delete next[head];
        else next[head] = value;

        return next;
    }
    const child = writeAt((next[head] as ChannelConfig) ?? {}, rest, value);
    if (Object.keys(child).length === 0) delete next[head];
    else next[head] = child;

    return next;
}

/** Serialize a raw input string to the field's stored type, or `undefined` when empty. */
function parseFieldValue(type: FieldType, raw: string): unknown {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (type === "stringList") {
        return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (type === "numberList") {
        const nums = trimmed.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));

        return nums.length > 0 ? nums : undefined;
    }

    return trimmed;
}

/** Render a field's stored value back into its input string. */
function formatFieldValue(value: unknown): string {
    if (Array.isArray(value)) return value.join(", ");

    return value == null ? "" : String(value);
}

/** Secret input with a show/hide toggle; accepts `${ENV}` placeholders. */
function SecretField({ defaultValue, placeholder, onCommit }: { defaultValue: string; placeholder?: string; onCommit: (v: string) => void }) {
    const [show, setShow] = useState(false);

    return (
        <div className="flex items-center gap-1.5">
            <Input
                type={show ? "text" : "password"}
                defaultValue={defaultValue}
                key={defaultValue}
                placeholder={placeholder ?? "${ENV_NAME} or literal"}
                className="h-7 flex-1 font-mono text-[11px]"
                onBlur={(e) => onCommit(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") onCommit((e.target as HTMLInputElement).value);
                }}
            />
            <Button
                size="icon-xs"
                variant="ghost"
                type="button"
                className="cursor-pointer"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? "Hide" : "Show"}
            >
                {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
        </div>
    );
}

/** Agent channels editor — lists configured channels and lets the user add the remaining kinds. */
export function ChannelsSection({
    agentConfig,
    onUpdateChannel,
}: {
    agentConfig: Doc<"agentConfigs"> | null | undefined;
    onUpdateChannel: (kind: string, config: ChannelConfig | null) => Promise<void>;
}) {
    const channels = useMemo(
        () => readAgentBranch<Record<string, ChannelConfig>>(agentConfig as FlatAgentConfig | undefined, "channels"),
        [agentConfig],
    );

    const configured = CHANNELS.filter((c) => channels[c.kind] !== undefined);
    const available = CHANNELS.filter((c) => channels[c.kind] === undefined);

    // Channel kind pending delete confirmation.
    const [deletingChannel, setDeletingChannel] = useState<ChannelKind | null>(null);
    const [isDeletingChannel, setIsDeletingChannel] = useState(false);

    /** Commit a single field edit for a channel kind. */
    function commitField(kind: string, field: ChannelField, raw: string) {
        const current = (channels[kind] as ChannelConfig | undefined) ?? {};
        const next = writeAt(current, field.path ?? [field.key], parseFieldValue(field.type, raw));
        void onUpdateChannel(kind, next);
    }

    async function handleDeleteChannel() {
        if (!deletingChannel) return;
        setIsDeletingChannel(true);
        try {
            await onUpdateChannel(deletingChannel.kind, null);
            setDeletingChannel(null);
        } finally {
            setIsDeletingChannel(false);
        }
    }

    return (
        <>
            <div className="flex flex-col gap-3">
                <SectionHeader>Channels</SectionHeader>
                <p className="text-[11px] text-muted-foreground">
                    Inbound triggers the agent replies on. Secrets accept <code className="rounded bg-muted px-1">${"{ENV}"}</code> placeholders.
                </p>

                {configured.map((channel) => (
                    <div key={channel.kind} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-foreground">{channel.label}</span>
                            <button
                                className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive"
                                onClick={() => setDeletingChannel(channel)}
                                title={`Remove ${channel.label}`}
                            >
                                <Trash2 className="size-3" />
                                Remove
                            </button>
                        </div>
                        {channel.fields.map((field) => {
                            const stored = formatFieldValue(readAt((channels[channel.kind] as ChannelConfig) ?? {}, field.path ?? [field.key]));

                            return (
                                <div key={field.key} className="flex flex-col gap-1">
                                    <span className="text-[11px] text-muted-foreground">
                                        {field.label}
                                        {field.required && <span className="text-destructive"> *</span>}
                                    </span>
                                    {field.type === "secret" ? (
                                        <SecretField
                                            defaultValue={stored}
                                            placeholder={field.placeholder}
                                            onCommit={(v) => commitField(channel.kind, field, v)}
                                        />
                                    ) : (
                                        <Input
                                            defaultValue={stored}
                                            key={stored}
                                            placeholder={field.placeholder}
                                            className="h-7 text-[11px]"
                                            onBlur={(e) => commitField(channel.kind, field, e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") commitField(channel.kind, field, (e.target as HTMLInputElement).value);
                                            }}
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ))}

                {available.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {available.map((channel) => (
                            <Button
                                key={channel.kind}
                                size="sm"
                                variant="outline"
                                className="h-7 cursor-pointer gap-1 text-[11px]"
                                onClick={() => void onUpdateChannel(channel.kind, {})}
                            >
                                <Plus className="size-3" />
                                {channel.label}
                            </Button>
                        ))}
                    </div>
                )}
            </div>

            {deletingChannel && (
                <DeleteConfirmDialog
                    open={deletingChannel !== null}
                    onOpenChange={(open) => {
                        if (!open) setDeletingChannel(null);
                    }}
                    resourceName={deletingChannel.kind}
                    resourceType="channel"
                    critical={false}
                    onConfirm={handleDeleteChannel}
                    isDeleting={isDeletingChannel}
                />
            )}
        </>
    );
}
