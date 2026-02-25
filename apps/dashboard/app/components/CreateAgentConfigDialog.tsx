"use client";

/** Dialog form for creating a new agent configuration and adding it to the canvas. */
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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
import { useMutation } from "convex/react";
import { useState } from "react";

/** Dialog form for creating a new agent config and adding it to the canvas. */
export function CreateAgentConfigDialog({
    projectId,
    environmentId,
    open,
    onOpenChange,
}: {
    projectId: Id<"projects">;
    environmentId: Id<"environments"> | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const createAgentConfig = useMutation(api.agentConfig.create);
    const [name, setName] = useState("");
    const [modelId, setModelId] = useState("");
    const [description, setDescription] = useState("");
    const [systemPrompt, setSystemPrompt] = useState("");
    const [isCreating, setIsCreating] = useState(false);

    function resetForm() {
        setName("");
        setModelId("");
        setDescription("");
        setSystemPrompt("");
    }

    async function handleCreate() {
        if (!name.trim() || !modelId.trim()) return;
        setIsCreating(true);
        try {
            await createAgentConfig({
                projectId: projectId,
                environmentId: environmentId ?? undefined,
                name: name.trim(),
                modelId: modelId.trim(),
                description: description.trim() || undefined,
                systemPrompt: systemPrompt.trim() || undefined,
            });
            resetForm();
            onOpenChange(false);
        } finally {
            setIsCreating(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Create Agent Config</DialogTitle>
                    <DialogDescription>
                        Configure a new AI agent for your project.
                    </DialogDescription>
                </DialogHeader>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleCreate();
                    }}
                >
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="agent-name">Name</Label>
                            <Input
                                id="agent-name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="My Agent"
                                autoFocus
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="agent-model">Model ID</Label>
                            <Input
                                id="agent-model"
                                value={modelId}
                                onChange={(e) => setModelId(e.target.value)}
                                placeholder="claude-sonnet-4-20250514"
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="agent-description">
                                Description (optional)
                            </Label>
                            <Input
                                id="agent-description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="What does this agent do?"
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="agent-prompt">
                                System Prompt (optional)
                            </Label>
                            <Input
                                id="agent-prompt"
                                value={systemPrompt}
                                onChange={(e) => setSystemPrompt(e.target.value)}
                                placeholder="You are a helpful assistant..."
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={!name.trim() || !modelId.trim() || isCreating}
                        >
                            {isCreating ? "Creating..." : "Create"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
