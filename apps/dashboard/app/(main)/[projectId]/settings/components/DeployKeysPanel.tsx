"use client";

/** Deploy keys panel: scoped CLI tokens that deploy only to the active environment. */
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Check, Copy, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

interface Props {
    /** Project that owns the environment. */
    projectId: Id<"projects">;
    /** Active environment the keys are scoped to, or null while none is selected. */
    environmentId: Id<"environments"> | null;
}

/** Lists, creates (with one-time reveal), and revokes deploy keys for the active environment. */
export function DeployKeysPanel({ projectId, environmentId }: Props) {
    const deployKeys = useQuery(
        api.deployKeys.list,
        environmentId ? { projectId: projectId, environmentId: environmentId } : "skip",
    ) as Doc<"deployKeys">[] | undefined;
    const createKey = useMutation(api.deployKeys.create);
    const removeKey = useMutation(api.deployKeys.remove);

    const [adding, setAdding] = useState(false);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [revealed, setRevealed] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    async function handleCreate() {
        if (!name.trim() || busy || !environmentId) return;
        setBusy(true);
        setError(null);
        try {
            const result = await createKey({
                projectId: projectId,
                environmentId: environmentId,
                name: name.trim(),
            });
            setRevealed(result.token);
            setName("");
            setAdding(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create deploy key");
        } finally {
            setBusy(false);
        }
    }

    function copyToken() {
        if (!revealed) return;
        navigator.clipboard.writeText(revealed);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    if (!environmentId) {
        return (
            <Section title="Deploy keys" description="Scoped CLI tokens that deploy only to this environment.">
                <p className="text-sm text-muted-foreground">Select an environment to manage its deploy keys.</p>
            </Section>
        );
    }

    return (
        <Section title="Deploy keys" description="Scoped CLI tokens that deploy only to this environment.">
            {revealed && (
                <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
                    <p className="mb-1 text-xs font-medium text-foreground">
                        Copy this token now — it won&apos;t be shown again.
                    </p>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                            {revealed}
                        </code>
                        <Button variant="outline" size="sm" className="cursor-pointer" onClick={copyToken}>
                            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="cursor-pointer"
                            onClick={() => setRevealed(null)}
                        >
                            Done
                        </Button>
                    </div>
                </div>
            )}

            {deployKeys && deployKeys.length === 0 && (
                <p className="text-sm text-muted-foreground">No deploy keys yet.</p>
            )}
            <div className="grid gap-2">
                {deployKeys?.map((key) => (
                    <div key={key._id} className="flex items-center gap-2">
                        <span className="flex-1 truncate text-sm font-medium text-foreground">{key.name}</span>
                        <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                            {key.keyHint}
                        </code>
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            className="cursor-pointer text-muted-foreground hover:text-destructive"
                            onClick={() => removeKey({ deployKeyId: key._id })}
                        >
                            <Trash2 className="size-3.5" />
                        </Button>
                    </div>
                ))}
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            {adding ? (
                <div className="flex items-center gap-2">
                    <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Key name (e.g. CI staging)"
                        className="flex-1 text-sm"
                        autoFocus
                    />
                    <Button
                        size="sm"
                        className="cursor-pointer disabled:cursor-not-allowed"
                        disabled={!name.trim() || busy}
                        onClick={handleCreate}
                    >
                        {busy ? "Creating…" : "Create"}
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="cursor-pointer"
                        onClick={() => {
                            setAdding(false);
                            setName("");
                            setError(null);
                        }}
                    >
                        Cancel
                    </Button>
                </div>
            ) : (
                <Button
                    variant="outline"
                    size="sm"
                    className="w-fit cursor-pointer"
                    onClick={() => setAdding(true)}
                >
                    <Plus className="mr-1 size-3.5" />
                    New Deploy Key
                </Button>
            )}
        </Section>
    );
}
