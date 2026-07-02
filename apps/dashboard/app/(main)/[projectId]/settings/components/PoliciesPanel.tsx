"use client";

/** Agent runtime policy list and JSON document editor. */
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

interface Props {
    projectId: Id<"projects">;
    environmentId: Id<"environments"> | null;
}

const DEFAULT_POLICY_DOCUMENT = {
    version: 1,
    rules: [
        {
            id: "allow-tools",
            effect: "allow",
            actions: ["tool.call"],
        },
    ],
};

export function PoliciesPanel({ projectId, environmentId }: Props) {
    const policies = useQuery(
        api.agentPolicies.listForEnvironment,
        environmentId ? { projectId: projectId, environmentId: environmentId } : "skip",
    ) as Doc<"agentPolicies">[] | undefined;
    const createPolicy = useMutation(api.agentPolicies.create);
    const updatePolicy = useMutation(api.agentPolicies.update);
    const removePolicy = useMutation(api.agentPolicies.remove);

    const [editing, setEditing] = useState<Doc<"agentPolicies"> | "new" | null>(null);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [documentText, setDocumentText] = useState(JSON.stringify(DEFAULT_POLICY_DOCUMENT, null, 2));
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [deletingPolicy, setDeletingPolicy] = useState<Doc<"agentPolicies"> | null>(null);

    function beginNew() {
        setEditing("new");
        setName("");
        setDescription("");
        setDocumentText(JSON.stringify(DEFAULT_POLICY_DOCUMENT, null, 2));
        setError(null);
    }

    function beginEdit(policy: Doc<"agentPolicies">) {
        setEditing(policy);
        setName(policy.name);
        setDescription(policy.description ?? "");
        setDocumentText(JSON.stringify(policy.document, null, 2));
        setError(null);
    }

    async function savePolicy() {
        if (!environmentId || !name.trim()) return;
        let document: unknown;
        try {
            document = JSON.parse(documentText);
        } catch {
            setError("Policy document must be valid JSON.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            if (editing === "new") {
                await createPolicy({
                    projectId: projectId,
                    environmentId: environmentId,
                    name: name.trim(),
                    description: description.trim() || undefined,
                    document: document,
                });
            } else if (editing) {
                await updatePolicy({
                    policyId: editing._id,
                    name: name.trim(),
                    description: description.trim() || null,
                    document: document,
                });
            }
            setEditing(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save policy.");
        } finally {
            setBusy(false);
        }
    }

    async function deletePolicy() {
        if (!deletingPolicy) return;
        await removePolicy({ policyId: deletingPolicy._id });
        setDeletingPolicy(null);
        if (editing && editing !== "new" && editing._id === deletingPolicy._id) setEditing(null);
    }

    if (!environmentId) {
        return (
            <Section description="Reusable runtime authorization policies for agents.">
                <p className="text-sm text-muted-foreground">Select an environment to manage policies.</p>
            </Section>
        );
    }

    return (
        <>
            <Section description="Reusable runtime authorization policies for agents.">
                <div className="flex justify-end">
                    <Button variant="outline" size="sm" className="cursor-pointer" onClick={beginNew}>
                        <Plus className="mr-1 size-3.5" />
                        New Policy
                    </Button>
                </div>
                <div className="grid gap-2">
                    {policies?.map((policy) => (
                        <div key={policy._id} className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-foreground">{policy.name}</p>
                                {policy.description && (
                                    <p className="truncate text-xs text-muted-foreground">{policy.description}</p>
                                )}
                            </div>
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                className="cursor-pointer text-muted-foreground"
                                onClick={() => beginEdit(policy)}
                            >
                                <Pencil className="size-3.5" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                className="cursor-pointer text-muted-foreground hover:text-destructive"
                                onClick={() => setDeletingPolicy(policy)}
                            >
                                <Trash2 className="size-3.5" />
                            </Button>
                        </div>
                    ))}
                    {policies && policies.length === 0 && (
                        <p className="text-sm text-muted-foreground">No policies yet.</p>
                    )}
                </div>

                {editing && (
                    <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-3">
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Policy name"
                            className="text-sm"
                        />
                        <Input
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            placeholder="Description"
                            className="text-sm"
                        />
                        <Textarea
                            value={documentText}
                            onChange={(event) => setDocumentText(event.target.value)}
                            className="min-h-64 font-mono text-xs"
                        />
                        {error && <p className="text-xs text-destructive">{error}</p>}
                        <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => setEditing(null)}>
                                Cancel
                            </Button>
                            <Button size="sm" className="cursor-pointer" disabled={busy || !name.trim()} onClick={savePolicy}>
                                {busy ? "Saving..." : "Save"}
                            </Button>
                        </div>
                    </div>
                )}
            </Section>

            {deletingPolicy && (
                <DeleteConfirmDialog
                    open={deletingPolicy !== null}
                    onOpenChange={(open) => {
                        if (!open) setDeletingPolicy(null);
                    }}
                    resourceName={deletingPolicy.name}
                    resourceType="policy"
                    critical={false}
                    onConfirm={deletePolicy}
                    isDeleting={false}
                />
            )}
        </>
    );
}
