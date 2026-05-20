"use client";

import { Section } from "@/app/components/Section";
import { Avatar, AvatarFallback, AvatarImage } from "@/app/components/ui/avatar";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Separator } from "@/app/components/ui/separator";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ConfiguredPlanTier, PlanTier } from "@/lib/pricing";
import { isMaxPlan, PLAN_CONFIGS, resolvePlan, UPGRADE_URL } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { useWorkOSSession } from "@/lib/workos";
import { useMutation, useQuery } from "convex/react";
import {
    ArrowUpRight,
    ChevronDown, ChevronUp,
    Copy, Eye, EyeOff,
    Globe,
    Key,
    Moon,
    Plus, RefreshCw,
    Sun,
    Trash2,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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

type SettingsTab = "account" | "environments" | "api-keys" | "webhooks" | "danger";

const TABS: Array<{ id: SettingsTab; label: string; danger?: boolean }> = [
    { id: "account", label: "Account" },
    { id: "environments", label: "Environments" },
    { id: "api-keys", label: "API Keys" },
    { id: "webhooks", label: "Webhooks" },
    { id: "danger", label: "Danger Zone", danger: true },
];

const DELETE_ACCOUNT_PHRASE = "delete my account";
const HANDLE_REGEX = /^[a-z0-9_-]{3,32}$/;

function generateSecret() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface EnvVariable {
    id: string;
    key: string;
    value: string;
}

interface Environment {
    id: string;
    name: string;
    isDefault: boolean;
    variables: EnvVariable[];
}

interface WebhookEntry {
    id: string;
    url: string;
    secret: string;
    events: string[];
    active: boolean;
}

export default function SettingsPage() {
    const params = useParams<{ projectId: string }>();
    const searchParams = useSearchParams();
    const projectId = params.projectId as Id<"projects">;
    const router = useRouter();
    const { theme, setTheme } = useTheme();
    const { identity, claims } = useWorkOSSession();

    const currentUser = useQuery(api.user.getCurrent);
    const updateProfile = useMutation(api.user.updateProfile);
    const requestAccountDeletion = useMutation(api.user.requestAccountDeletion);

    const activeTab = (searchParams.get("tab") as SettingsTab) || "account";

    // Account state
    const claimName = typeof claims?.name === "string" ? claims.name : "User";
    const claimEmail = typeof claims?.email === "string" ? claims.email : "Not available";
    const claimAvatar = typeof claims?.picture === "string" ? claims.picture : null;
    const claimNameRef = useRef(claimName);
    claimNameRef.current = claimName;

    const [name, setName] = useState("");
    const [accountHandle, setAccountHandle] = useState("");
    const [savedProfile, setSavedProfile] = useState<{ name: string; accountHandle: string } | null>(null);
    const [isDirty, setIsDirty] = useState(false);
    const [isSavingProfile, setIsSavingProfile] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saveNotice, setSaveNotice] = useState<string | null>(null);
    const [deleteAccountDialogOpen, setDeleteAccountDialogOpen] = useState(false);
    const [deleteAccountPhrase, setDeleteAccountPhrase] = useState("");
    const [isDeletingAccount, setIsDeletingAccount] = useState(false);
    const [scheduledDeletionAt, setScheduledDeletionAt] = useState<number | null>(null);
    const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);

    useEffect(() => {
        if (currentUser === undefined || isDirty) return;
        const nextName = currentUser?.name ?? claimNameRef.current;
        const nextHandle = currentUser?.accountHandle ?? "";
        setName(nextName);
        setAccountHandle(nextHandle);
        setSavedProfile({ name: nextName.trim(), accountHandle: nextHandle.trim().toLowerCase() });
        setScheduledDeletionAt(currentUser?.deletionScheduledFor ?? null);
    }, [currentUser, isDirty]);

    const normalizedHandle = accountHandle.trim().toLowerCase();
    const hasHandleError = normalizedHandle.length > 0 && !HANDLE_REGEX.test(normalizedHandle);
    const hasProfileChanges =
        savedProfile !== null &&
        (name.trim() !== savedProfile.name || normalizedHandle !== savedProfile.accountHandle);
    const avatarUrl = currentUser?.avatarUrl ?? claimAvatar;
    const accountId = currentUser?._id ?? identity?.userId ?? "";
    const email = currentUser?.email ?? claimEmail;
    const userPlan: ConfiguredPlanTier = resolvePlan(currentUser?.plan as PlanTier | undefined);
    const planConfig = PLAN_CONFIGS[userPlan];
    const showUpgrade = !isMaxPlan(userPlan);
    const effectiveDeletionAt = scheduledDeletionAt ?? currentUser?.deletionScheduledFor ?? null;

    // Environments state
    const [environments, setEnvironments] = useState<Environment[]>([
        { id: "1", name: "Production", isDefault: true, variables: [] },
    ]);
    const [showAddEnv, setShowAddEnv] = useState(false);
    const [newEnvName, setNewEnvName] = useState("");
    const [expandedEnvs, setExpandedEnvs] = useState<Set<string>>(new Set());
    const [newVarKey, setNewVarKey] = useState("");
    const [newVarValue, setNewVarValue] = useState("");
    const [addingVarToEnv, setAddingVarToEnv] = useState<string | null>(null);

    // API Keys state
    const [apiKeys, setApiKeys] = useState<Array<{ id: string; name: string; key: string; createdAt: string }>>([]);
    const [showKey, setShowKey] = useState<string | null>(null);
    const [newKeyName, setNewKeyName] = useState("");
    const [showNewKeyDialog, setShowNewKeyDialog] = useState(false);
    const [generatedKey, setGeneratedKey] = useState("");

    // Webhooks state
    const [webhooks, setWebhooks] = useState<WebhookEntry[]>([]);
    const [showAddWebhook, setShowAddWebhook] = useState(false);
    const [newWebhookUrl, setNewWebhookUrl] = useState("");
    const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>([]);
    const [showWebhookSecret, setShowWebhookSecret] = useState(false);

    async function handleSaveProfile() {
        const trimmedName = name.trim();
        if (!trimmedName) {
            setSaveError("Display name is required.");
            return;
        }
        if (hasHandleError) {
            setSaveError("Account handle must be 3-32 chars and use a-z, 0-9, '_' or '-'.");
            return;
        }
        setIsSavingProfile(true);
        setSaveError(null);
        setSaveNotice(null);
        try {
            await updateProfile({ name: trimmedName, accountHandle: normalizedHandle || undefined });
            setName(trimmedName);
            setAccountHandle(normalizedHandle);
            setSavedProfile({ name: trimmedName, accountHandle: normalizedHandle });
            setIsDirty(false);
            setSaveNotice("Changes saved.");
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : "Unable to save account settings.");
        } finally {
            setIsSavingProfile(false);
        }
    }

    async function handleDeleteAccount() {
        if (deleteAccountPhrase.trim().toLowerCase() !== DELETE_ACCOUNT_PHRASE) return;
        setIsDeletingAccount(true);
        setDeleteAccountError(null);
        try {
            const result = await requestAccountDeletion({});
            setScheduledDeletionAt(result.scheduledFor);
            setDeleteAccountDialogOpen(false);
            setDeleteAccountPhrase("");
        } catch (error) {
            setDeleteAccountError(error instanceof Error ? error.message : "Unable to schedule account deletion.");
        } finally {
            setIsDeletingAccount(false);
        }
    }

    function handleGenerateApiKey() {
        const newKey = `pnzu_prod_sk_${generateSecret()}`;
        setGeneratedKey(newKey);
        setApiKeys((prev) => [
            ...prev,
            { id: Date.now().toString(), name: newKeyName || "New Key", key: newKey, createdAt: new Date().toISOString().split("T")[0] },
        ]);
        setNewKeyName("");
        setShowNewKeyDialog(true);
    }

    function handleDeleteApiKey(id: string) {
        setApiKeys((prev) => prev.filter((k) => k.id !== id));
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text);
    }

    function toggleEnvExpand(id: string) {
        setExpandedEnvs((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function handleAddEnvironment() {
        if (!newEnvName.trim()) return;
        setEnvironments((prev) => [
            ...prev,
            { id: Date.now().toString(), name: newEnvName.trim(), isDefault: false, variables: [] },
        ]);
        setNewEnvName("");
        setShowAddEnv(false);
    }

    function handleDeleteEnvironment(id: string) {
        setEnvironments((prev) => prev.filter((e) => e.id !== id));
    }

    function handleAddVariable(envId: string) {
        if (!newVarKey.trim()) return;
        setEnvironments((prev) =>
            prev.map((env) =>
                env.id === envId
                    ? { ...env, variables: [...env.variables, { id: Date.now().toString(), key: newVarKey.trim(), value: newVarValue }] }
                    : env,
            ),
        );
        setNewVarKey("");
        setNewVarValue("");
        setAddingVarToEnv(null);
    }

    function handleDeleteVariable(envId: string, varId: string) {
        setEnvironments((prev) =>
            prev.map((env) =>
                env.id === envId
                    ? { ...env, variables: env.variables.filter((v) => v.id !== varId) }
                    : env,
            ),
        );
    }

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

    if (currentUser === undefined) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">Loading…</p>
            </div>
        );
    }

    const isDark = theme === "dark";

    const renderContent = () => {
        switch (activeTab) {
            case "account":
                return (
                    <div className="grid gap-8">
                        <Section title="Profile" description="Editable attributes for your account.">
                            <div className="grid gap-4">
                                <div className="grid gap-2">
                                    <Label htmlFor="account-display-name">Display name</Label>
                                    <Input
                                        id="account-display-name"
                                        value={name}
                                        onChange={(event) => {
                                            setName(event.target.value);
                                            setIsDirty(true);
                                            setSaveError(null);
                                            setSaveNotice(null);
                                        }}
                                        placeholder="Your display name"
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label htmlFor="account-handle">Account handle</Label>
                                    <Input
                                        id="account-handle"
                                        value={accountHandle}
                                        onChange={(event) => {
                                            setAccountHandle(event.target.value);
                                            setIsDirty(true);
                                            setSaveError(null);
                                            setSaveNotice(null);
                                        }}
                                        placeholder="your_handle"
                                    />
                                    <p className={cn("text-xs", hasHandleError ? "text-destructive" : "text-muted-foreground")}>
                                        {hasHandleError
                                            ? "Use 3-32 chars: lowercase letters, numbers, '_' or '-'."
                                            : "Public identifier shown as @handle."}
                                    </p>
                                </div>
                                <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
                                    <p className="text-xs text-muted-foreground">
                                        {hasProfileChanges ? "You have unsaved changes." : saveNotice ?? "All changes saved."}
                                    </p>
                                    <Button
                                        size="sm"
                                        className="cursor-pointer"
                                        onClick={handleSaveProfile}
                                        disabled={!hasProfileChanges || hasHandleError || !name.trim() || isSavingProfile}
                                    >
                                        {isSavingProfile ? "Saving..." : "Save changes"}
                                    </Button>
                                </div>
                                {saveError && <p className="text-sm text-destructive">{saveError}</p>}
                            </div>
                        </Section>

                        <Separator />

                        <Section title="Avatar" description="Preview from your identity provider.">
                            <div className="flex items-center gap-5 rounded-lg border border-border bg-card px-5 py-4">
                                <Avatar className="size-24">
                                    {avatarUrl && <AvatarImage src={avatarUrl} alt={name || "User"} />}
                                    <AvatarFallback className="text-xl font-semibold">
                                        {(name || "U")
                                            .split(" ")
                                            .map((part) => part[0])
                                            .slice(0, 2)
                                            .join("")
                                            .toUpperCase()}
                                    </AvatarFallback>
                                </Avatar>
                                <div className="grid gap-1">
                                    <p className="text-sm font-medium text-foreground">Profile photo</p>
                                    <p className="text-xs text-muted-foreground">
                                        Avatar URL is hidden here. This is a larger preview only.
                                    </p>
                                </div>
                            </div>
                        </Section>

                        <Separator />

                        <Section title="Account Overview" description="Read-only account details.">
                            <div className="rounded-lg border border-border bg-card">
                                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                                    <span className="text-xs text-muted-foreground">Email</span>
                                    <span className="text-sm text-foreground">{email}</span>
                                </div>
                                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                                    <span className="text-xs text-muted-foreground">Account ID</span>
                                    <span className="font-mono text-xs text-muted-foreground">{accountId}</span>
                                </div>
                                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                                    <span className="text-xs text-muted-foreground">Auth provider</span>
                                    <span className="text-sm text-foreground">Google via WorkOS</span>
                                </div>
                                <div className="flex items-center justify-between px-4 py-3">
                                    <span className="text-xs text-muted-foreground">Plan</span>
                                    <div className="flex items-center gap-2">
                                        <Badge className={planConfig.badgeClass}>{planConfig.label}</Badge>
                                        {showUpgrade && (
                                            <Button size="xs" asChild>
                                                <a href={UPGRADE_URL} target="_blank" rel="noopener noreferrer">
                                                    Upgrade
                                                    <ArrowUpRight className="size-3" />
                                                </a>
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </Section>

                        <Separator />

                        <Section title="Preferences" description="Local preferences for your workspace.">
                            <div className="rounded-lg border border-border bg-card p-4">
                                <p className="mb-3 text-sm font-medium text-foreground">Theme</p>
                                <div className="flex items-center gap-2">
                                    <Button
                                        size="sm"
                                        className="cursor-pointer"
                                        variant={theme === "light" ? "default" : "outline"}
                                        onClick={() => setTheme("light")}
                                    >
                                        <Sun className="size-4 mr-1" />
                                        Light
                                    </Button>
                                    <Button
                                        size="sm"
                                        className="cursor-pointer"
                                        variant={theme === "dark" ? "default" : "outline"}
                                        onClick={() => setTheme("dark")}
                                    >
                                        <Moon className="size-4 mr-1" />
                                        Dark
                                    </Button>
                                </div>
                            </div>
                        </Section>
                    </div>
                );

            case "environments":
                return (
                    <div className="grid gap-4">
                        {environments.map((env) => (
                            <div key={env.id} className="rounded-lg border border-border bg-card">
                                <div className="flex items-center justify-between px-4 py-3">
                                    <div className="flex items-center gap-3">
                                        <span className="text-sm font-medium text-foreground">{env.name}</span>
                                        {env.isDefault && <Badge variant="outline">Default</Badge>}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Button
                                            variant="ghost"
                                            size="icon-xs"
                                            className="cursor-pointer text-muted-foreground hover:text-foreground"
                                            onClick={() => toggleEnvExpand(env.id)}
                                        >
                                            {expandedEnvs.has(env.id) ? (
                                                <ChevronUp className="size-4" />
                                            ) : (
                                                <ChevronDown className="size-4" />
                                            )}
                                        </Button>
                                        {!env.isDefault && (
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
                                                onClick={() => handleDeleteEnvironment(env.id)}
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        )}
                                    </div>
                                </div>
                                {expandedEnvs.has(env.id) && (
                                    <div className="border-t border-border px-4 py-3">
                                        <p className="mb-2 text-xs font-medium text-muted-foreground uppercase">Variables</p>
                                        {env.variables.length === 0 && (
                                            <p className="mb-2 text-xs text-muted-foreground">No variables yet.</p>
                                        )}
                                        <div className="grid gap-2 mb-3">
                                            {env.variables.map((v) => (
                                                <div key={v.id} className="flex items-center gap-2">
                                                    <code className="flex-1 font-mono text-xs bg-muted px-2 py-1 rounded">{v.key}</code>
                                                    <code className="flex-1 font-mono text-xs bg-muted px-2 py-1 rounded truncate">
                                                        {v.value ? "••••••••" : <span className="text-muted-foreground">empty</span>}
                                                    </code>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon-xs"
                                                        className="cursor-pointer text-muted-foreground hover:text-destructive"
                                                        onClick={() => handleDeleteVariable(env.id, v.id)}
                                                    >
                                                        <Trash2 className="size-3.5" />
                                                    </Button>
                                                </div>
                                            ))}
                                        </div>
                                        {addingVarToEnv === env.id ? (
                                            <div className="flex items-center gap-2">
                                                <Input
                                                    value={newVarKey}
                                                    onChange={(e) => setNewVarKey(e.target.value)}
                                                    placeholder="KEY_NAME"
                                                    className="flex-1 font-mono text-xs"
                                                />
                                                <Input
                                                    value={newVarValue}
                                                    onChange={(e) => setNewVarValue(e.target.value)}
                                                    placeholder="value"
                                                    className="flex-1 font-mono text-xs"
                                                />
                                                <Button size="sm" className="cursor-pointer" onClick={() => handleAddVariable(env.id)}>Add</Button>
                                                <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => { setAddingVarToEnv(null); setNewVarKey(""); setNewVarValue(""); }}>Cancel</Button>
                                            </div>
                                        ) : (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="cursor-pointer"
                                                onClick={() => setAddingVarToEnv(env.id)}
                                            >
                                                <Plus className="size-3.5 mr-1" />Add Variable
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                        {showAddEnv ? (
                            <div className="flex items-center gap-2">
                                <Input
                                    value={newEnvName}
                                    onChange={(e) => setNewEnvName(e.target.value)}
                                    placeholder="Environment name"
                                    className="flex-1"
                                    autoFocus
                                />
                                <Button size="sm" className="cursor-pointer" onClick={handleAddEnvironment}>Create</Button>
                                <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => { setShowAddEnv(false); setNewEnvName(""); }}>Cancel</Button>
                            </div>
                        ) : (
                            <Button variant="outline" size="sm" className="cursor-pointer w-fit" onClick={() => setShowAddEnv(true)}>
                                <Plus className="size-4 mr-1" />Add Environment
                            </Button>
                        )}
                    </div>
                );

            case "api-keys":
                return (
                    <div className="grid gap-4">
                        {apiKeys.length === 0 && (
                            <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                                <Key className="size-8 mx-auto mb-2 text-muted-foreground" />
                                <p className="text-sm text-muted-foreground">No API keys yet. Generate one to get started.</p>
                            </div>
                        )}
                        {apiKeys.map((apiKey) => (
                            <div key={apiKey.id} className="rounded-lg border border-border bg-card px-4 py-3">
                                <div className="flex items-center gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium text-foreground">{apiKey.name}</span>
                                            <Badge variant="secondary" className="text-xs">Active</Badge>
                                        </div>
                                        <div className="flex items-center gap-1.5 mt-1">
                                            <code className="font-mono text-xs text-muted-foreground truncate">
                                                {showKey === apiKey.id ? apiKey.key : apiKey.key.replace(/.(?=.{4})/g, "•")}
                                            </code>
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                className="cursor-pointer text-muted-foreground hover:text-foreground"
                                                onClick={() => setShowKey(showKey === apiKey.id ? null : apiKey.id)}
                                            >
                                                {showKey === apiKey.id ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                className="cursor-pointer text-muted-foreground hover:text-foreground"
                                                onClick={() => copyToClipboard(apiKey.key)}
                                            >
                                                <Copy className="size-3.5" />
                                            </Button>
                                        </div>
                                        <span className="text-xs text-muted-foreground">Created {apiKey.createdAt}</span>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
                                        onClick={() => handleDeleteApiKey(apiKey.id)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            </div>
                        ))}
                        <div className="flex items-center gap-2">
                            <Input
                                value={newKeyName}
                                onChange={(e) => setNewKeyName(e.target.value)}
                                placeholder="Key name (e.g., Production)"
                                className="flex-1"
                            />
                            <Button size="sm" className="cursor-pointer" onClick={handleGenerateApiKey}>
                                <Plus className="size-4 mr-1" />
                                Generate Key
                            </Button>
                        </div>
                    </div>
                );

            case "webhooks":
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
                                    <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => setShowAddWebhook(false)}>Cancel</Button>
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

            case "danger":
                return (
                    <Section
                        title="Delete Account"
                        description="Permanently delete your account and all associated data."
                        danger
                    >
                        <div className="grid gap-4">
                            {effectiveDeletionAt ? (
                                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
                                    <p className="text-sm text-foreground">
                                        Account deletion is scheduled for{" "}
                                        <span className="font-medium">
                                            {new Date(effectiveDeletionAt).toLocaleString()}
                                        </span>
                                        .
                                    </p>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Your account is not deleted yet. If this was accidental, contact support within 7 days to restore it.
                                    </p>
                                </div>
                            ) : (
                                <div className="flex items-center justify-between gap-6">
                                    <div>
                                        <p className="text-sm font-medium text-foreground">Delete account</p>
                                        <p className="text-xs text-muted-foreground">
                                            Deletion is delayed for 7 days. During that window, support can restore your account if needed.
                                        </p>
                                    </div>
                                    <Button
                                        variant="destructive"
                                        size="sm"
                                        className="shrink-0 cursor-pointer"
                                        onClick={() => {
                                            setDeleteAccountError(null);
                                            setDeleteAccountPhrase("");
                                            setDeleteAccountDialogOpen(true);
                                        }}
                                    >
                                        Delete Account
                                    </Button>
                                </div>
                            )}
                            {deleteAccountError && <p className="text-sm text-destructive">{deleteAccountError}</p>}
                        </div>
                    </Section>
                );

            default:
                return null;
        }
    };

    return (
        <div className="flex h-full">
            <aside className="flex w-48 shrink-0 flex-col bg-transparent">
                <div className="px-6 pt-9.25 pb-3">
                    <h2 className="text-lg font-semibold text-foreground">Settings</h2>
                </div>
                <nav className="flex flex-col gap-0.5 px-6">
                    {TABS.map((tab) => (
                        <Button
                            key={tab.id}
                            variant="ghost"
                            size="sm"
                            className={cn(
                                "w-full justify-start px-3 cursor-pointer",
                                activeTab === tab.id
                                    ? tab.danger
                                        ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                                        : "bg-accent text-foreground"
                                    : tab.danger
                                        ? "text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                            )}
                            onClick={() => {
                                const p = new URLSearchParams(searchParams.toString());
                                p.set("tab", tab.id);
                                router.push(`/${projectId}/settings?${p.toString()}`);
                            }}
                        >
                            {tab.label}
                        </Button>
                    ))}
                </nav>
            </aside>

            <div className="flex flex-1 flex-col overflow-auto">
                <div className="mx-auto w-full max-w-2xl px-6 py-10">
                    {renderContent()}
                </div>
            </div>

            {/* Delete account dialog */}
            <Dialog open={deleteAccountDialogOpen} onOpenChange={setDeleteAccountDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-destructive">Delete account</DialogTitle>
                        <DialogDescription>
                            This schedules account deletion after 7 days. Type{" "}
                            <span className="font-mono text-foreground">{DELETE_ACCOUNT_PHRASE}</span>{" "}
                            to continue.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-2 py-2">
                        <Label htmlFor="delete-account-confirmation">Confirmation phrase</Label>
                        <Input
                            id="delete-account-confirmation"
                            value={deleteAccountPhrase}
                            onChange={(event) => setDeleteAccountPhrase(event.target.value)}
                            placeholder={DELETE_ACCOUNT_PHRASE}
                            autoFocus
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" className="cursor-pointer" onClick={() => setDeleteAccountDialogOpen(false)}>Cancel</Button>
                        <Button type="button" variant="destructive" className="cursor-pointer" disabled={deleteAccountPhrase.trim().toLowerCase() !== DELETE_ACCOUNT_PHRASE || isDeletingAccount} onClick={handleDeleteAccount}>
                            {isDeletingAccount ? "Scheduling..." : "Schedule deletion"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* New API Key dialog */}
            <Dialog
                open={showNewKeyDialog}
                onOpenChange={(open) => {
                    if (!open) {
                        setShowNewKeyDialog(false);
                        setGeneratedKey("");
                    }
                }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>API Key Generated</DialogTitle>
                        <DialogDescription asChild>
                            <div className="grid gap-3 text-sm text-muted-foreground">
                                <p>Your new API key has been generated. Copy it now &mdash; you won&apos;t be able to see it again.</p>
                            </div>
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-2">
                        <Label htmlFor="new-api-key" className="grid gap-1">
                            <span>Your API Key</span>
                            <code className="font-mono text-sm bg-muted px-3 py-2 rounded-md break-all block">{generatedKey}</code>
                        </Label>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" className="cursor-pointer" onClick={() => copyToClipboard(generatedKey)}>
                            <Copy className="size-4 mr-1" />Copy Key
                        </Button>
                        <Button className="cursor-pointer" onClick={() => { setShowNewKeyDialog(false); setGeneratedKey(""); }}>Done</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
