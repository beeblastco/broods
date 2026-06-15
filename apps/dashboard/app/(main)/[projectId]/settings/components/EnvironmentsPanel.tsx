"use client";

/** Environments panel: manage runtime variables for the environment currently selected in the header. */
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

interface Props {
    /** Project that owns the environment. */
    projectId: Id<"projects">;
    /** Active environment whose variables are managed, or null while none is selected. */
    environmentId: Id<"environments"> | null;
}

/** Lists, adds, and removes runtime variables for the active environment. */
export function EnvironmentsPanel({ projectId, environmentId }: Props) {
    const variables = useQuery(
        api.environmentVariables.list,
        environmentId ? { projectId: projectId, environmentId: environmentId } : "skip",
    );
    const setVariable = useMutation(api.environmentVariables.set);
    const removeVariable = useMutation(api.environmentVariables.remove);
    const revealVariable = useMutation(api.environmentVariables.reveal);

    const [adding, setAdding] = useState(false);
    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    // Plaintext values revealed via the eye icon, keyed by variable id. Each reveal is audited server-side.
    const [revealed, setRevealed] = useState<Record<string, string>>({});

    useEffect(() => {
        setRevealed({});
    }, [environmentId]);

    async function toggleReveal(variableId: Id<"environmentVariables">) {
        if (!environmentId) return;
        if (revealed[variableId] !== undefined) {
            setRevealed((prev) => {
                const next = { ...prev };
                delete next[variableId];

                return next;
            });

            return;
        }
        const { value: plaintext } = await revealVariable({
            projectId: projectId,
            environmentId: environmentId,
            variableId: variableId,
        });
        setRevealed((prev) => ({ ...prev, [variableId]: plaintext }));
    }

    async function handleAdd() {
        if (!name.trim() || busy || !environmentId) return;
        setBusy(true);
        try {
            await setVariable({
                projectId: projectId,
                environmentId: environmentId,
                name: name.trim(),
                value: value,
            });
            setName("");
            setValue("");
            setAdding(false);
        } finally {
            setBusy(false);
        }
    }

    if (!environmentId) {
        return (
            <Section title="Variables" description="Runtime variables for this environment.">
                <p className="text-sm text-muted-foreground">Select an environment to manage its variables.</p>
            </Section>
        );
    }

    return (
        <Section title="Variables" description="Runtime variables for this environment.">
            {variables && variables.length === 0 && (
                <p className="text-sm text-muted-foreground">No variables yet.</p>
            )}
            <div className="grid gap-2">
                {variables?.map((v) => (
                    <div key={v._id} className="flex items-center gap-2">
                        <code className="flex-1 rounded bg-muted px-2 py-1 font-mono text-xs">{v.name}</code>
                        <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                            {revealed[v._id] !== undefined
                                ? (revealed[v._id] || <span className="text-muted-foreground">empty</span>)
                                : v.value
                                    ? "••••••••"
                                    : <span className="text-muted-foreground">empty</span>}
                        </code>
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            className="cursor-pointer text-muted-foreground hover:text-foreground"
                            title={revealed[v._id] !== undefined ? "Hide value" : "Reveal value"}
                            onClick={() => toggleReveal(v._id)}
                        >
                            {revealed[v._id] !== undefined ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            className="cursor-pointer text-muted-foreground hover:text-destructive"
                            onClick={() => removeVariable({ variableId: v._id })}
                        >
                            <Trash2 className="size-3.5" />
                        </Button>
                    </div>
                ))}
            </div>
            {adding ? (
                <div className="flex items-center gap-2">
                    <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="KEY_NAME"
                        className="flex-1 font-mono text-xs"
                        autoFocus
                    />
                    <Input
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder="value"
                        className="flex-1 font-mono text-xs"
                    />
                    <Button
                        size="sm"
                        className="cursor-pointer disabled:cursor-not-allowed"
                        disabled={!name.trim() || busy}
                        onClick={handleAdd}
                    >
                        Add
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="cursor-pointer"
                        onClick={() => {
                            setAdding(false);
                            setName("");
                            setValue("");
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
                    Add Variable
                </Button>
            )}
        </Section>
    );
}
