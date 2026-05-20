"use client";

/** Environments panel: create and manage per-project runtime environments and their variables. */
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Badge } from "@/app/components/ui/badge";
import type { Id } from "@/convex/_generated/dataModel";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

interface Props {
    /** Project this settings panel belongs to. */
    projectId: Id<"projects">;
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

export function EnvironmentsPanel({ projectId: _projectId }: Props) {
    const [environments, setEnvironments] = useState<Environment[]>([
        { id: "1", name: "Production", isDefault: true, variables: [] },
    ]);
    const [showAddEnv, setShowAddEnv] = useState(false);
    const [newEnvName, setNewEnvName] = useState("");
    const [expandedEnvs, setExpandedEnvs] = useState<Set<string>>(new Set());
    const [newVarKey, setNewVarKey] = useState("");
    const [newVarValue, setNewVarValue] = useState("");
    const [addingVarToEnv, setAddingVarToEnv] = useState<string | null>(null);

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
                            <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">Variables</p>
                            {env.variables.length === 0 && (
                                <p className="mb-2 text-xs text-muted-foreground">No variables yet.</p>
                            )}
                            <div className="mb-3 grid gap-2">
                                {env.variables.map((v) => (
                                    <div key={v.id} className="flex items-center gap-2">
                                        <code className="flex-1 rounded bg-muted px-2 py-1 font-mono text-xs">{v.key}</code>
                                        <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
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
                                    <Button size="sm" className="cursor-pointer" onClick={() => handleAddVariable(env.id)}>
                                        Add
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="cursor-pointer"
                                        onClick={() => {
                                            setAddingVarToEnv(null);
                                            setNewVarKey("");
                                            setNewVarValue("");
                                        }}
                                    >
                                        Cancel
                                    </Button>
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
                    <Button size="sm" className="cursor-pointer" onClick={handleAddEnvironment}>
                        Create
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="cursor-pointer"
                        onClick={() => {
                            setShowAddEnv(false);
                            setNewEnvName("");
                        }}
                    >
                        Cancel
                    </Button>
                </div>
            ) : (
                <Button variant="outline" size="sm" className="cursor-pointer w-fit" onClick={() => setShowAddEnv(true)}>
                    <Plus className="size-4 mr-1" />Add Environment
                </Button>
            )}
        </div>
    );
}
