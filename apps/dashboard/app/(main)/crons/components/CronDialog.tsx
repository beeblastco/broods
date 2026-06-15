"use client";

/**
 * Create-or-edit dialog for a single cron job. Validates the schedule
 * expression client-side, then calls cronPublic.create or .update which
 * proxy to filthy-panty for the dual-write to EventBridge + Convex.
 */

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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/app/components/ui/select";
import { Textarea } from "@/app/components/ui/textarea";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Doc, Id } from "@filthy-panty/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { useState } from "react";

const SCHEDULE_REGEX = /^(cron|rate|at)\(.+\)$/;

const PRESETS: Array<{ label: string; value: string }> = [
    { label: "Every hour", value: "rate(1 hour)" },
    { label: "Every day at 9 AM UTC", value: "cron(0 9 * * ? *)" },
    { label: "Every Monday 09:00", value: "cron(0 9 ? * MON *)" },
    { label: "Every 15 minutes", value: "rate(15 minutes)" },
];

type Mode = "create" | "edit";

/** Extracts the editable text from a stored events list (first user text message). */
function eventsToText(events: Doc<"crons">["events"] | undefined): string {
    if (!Array.isArray(events)) return "";
    for (const message of events) {
        if (message?.role !== "user") continue;
        const content = message.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            const text = content
                .filter((part) => part?.type === "text")
                .map((part) => part.text)
                .join("\n");
            if (text) return text;
        }
    }

    return "";
}

interface Props {
    /** Whether this dialog creates a new job or edits an existing one. */
    mode: Mode;
    /** Existing cron job (when mode === "edit"). */
    cron?: Doc<"crons">;
    /** Agents available in the active org. */
    agents: Array<Doc<"agents">>;
    /** Called when the dialog should close (after success or cancel). */
    onClose: () => void;
}

export function CronDialog({ mode, cron, agents, onClose }: Props) {
    const create = useAction(api.cronPublic.create);
    const update = useAction(api.cronPublic.update);

    const [name, setName] = useState(cron?.name ?? "");
    const [description, setDescription] = useState(cron?.description ?? "");
    const [agentId, setAgentId] = useState<string>(cron?.agentId ?? agents[0]?._id ?? "");
    const [prompt, setPrompt] = useState(eventsToText(cron?.events));
    const [conversationKey, setConversationKey] = useState(cron?.conversationKey ?? "");
    const [scheduleExpression, setScheduleExpression] = useState(
        cron?.scheduleExpression ?? "",
    );
    const [timezone, setTimezone] = useState(cron?.timezone ?? "");
    const [status, setStatus] = useState<"active" | "paused">(cron?.status ?? "active");

    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const scheduleValid = SCHEDULE_REGEX.test(scheduleExpression.trim());
    const canSubmit =
        name.trim().length > 0 &&
        agentId.length > 0 &&
        prompt.trim().length > 0 &&
        scheduleValid &&
        !pending;

    async function handleSubmit() {
        if (!canSubmit) return;
        setPending(true);
        setError(null);
        try {
            if (mode === "create") {
                await create({
                    name: name.trim(),
                    agentId: agentId as Id<"agents">,
                    input: prompt.trim(),
                    conversationKey: conversationKey.trim() || undefined,
                    scheduleExpression: scheduleExpression.trim(),
                    timezone: timezone.trim() || undefined,
                    status: status,
                    description: description.trim() || undefined,
                });
            } else if (cron) {
                await update({
                    cronId: cron._id,
                    name: name.trim(),
                    agentId: agentId as Id<"agents">,
                    input: prompt.trim(),
                    conversationKey: conversationKey.trim() || undefined,
                    scheduleExpression: scheduleExpression.trim(),
                    timezone: timezone.trim() || undefined,
                    status: status,
                    description: description.trim() || undefined,
                });
            }
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Save failed");
        } finally {
            setPending(false);
        }
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {mode === "create" ? "New cron job" : "Edit cron job"}
                    </DialogTitle>
                    <DialogDescription>
                        Schedules an agent run via AWS EventBridge Scheduler.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-3 py-2">
                    <div className="grid gap-1">
                        <Label htmlFor="cj-name" className="text-xs text-muted-foreground">Name</Label>
                        <Input
                            id="cj-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Daily summary"
                        />
                    </div>

                    <div className="grid gap-1">
                        <Label htmlFor="cj-description" className="text-xs text-muted-foreground">Description</Label>
                        <Input
                            id="cj-description"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Optional"
                        />
                    </div>

                    <div className="grid gap-1">
                        <Label className="text-xs text-muted-foreground">Agent</Label>
                        {agents.length === 0 ? (
                            <p className="text-xs text-destructive">
                                No agents available. Create one before scheduling jobs.
                            </p>
                        ) : (
                            <Select value={agentId} onValueChange={setAgentId}>
                                <SelectTrigger className="w-full cursor-pointer">
                                    <SelectValue placeholder="Pick an agent" />
                                </SelectTrigger>
                                <SelectContent>
                                    {agents.map((agent) => (
                                        <SelectItem
                                            key={agent._id}
                                            value={agent._id}
                                            className="cursor-pointer"
                                        >
                                            {agent.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                    </div>

                    <div className="grid gap-1">
                        <Label htmlFor="cj-prompt" className="text-xs text-muted-foreground">Prompt</Label>
                        <Textarea
                            id="cj-prompt"
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            placeholder="What should the agent do on each invocation?"
                            rows={3}
                        />
                    </div>

                    <div className="grid gap-1">
                        <Label htmlFor="cj-conv" className="text-xs text-muted-foreground">
                            Conversation key (optional)
                        </Label>
                        <Input
                            id="cj-conv"
                            value={conversationKey}
                            onChange={(e) => setConversationKey(e.target.value)}
                            placeholder="Reuse a conversation across runs"
                        />
                    </div>

                    <div className="grid gap-1">
                        <Label htmlFor="cj-schedule" className="text-xs text-muted-foreground">
                            Schedule expression
                        </Label>
                        <Input
                            id="cj-schedule"
                            value={scheduleExpression}
                            onChange={(e) => setScheduleExpression(e.target.value)}
                            placeholder="rate(1 hour) or cron(0 9 * * ? *)"
                            className="font-mono text-xs"
                        />
                        <div className="flex flex-wrap gap-1.5 pt-1">
                            {PRESETS.map((preset) => (
                                <Button
                                    key={preset.value}
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs cursor-pointer"
                                    onClick={() => setScheduleExpression(preset.value)}
                                >
                                    {preset.label}
                                </Button>
                            ))}
                        </div>
                        {!scheduleValid && scheduleExpression.length > 0 && (
                            <p className="text-xs text-destructive">
                                Must match cron(...), rate(...), or at(...).
                            </p>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-1">
                            <Label htmlFor="cj-tz" className="text-xs text-muted-foreground">
                                Timezone (optional)
                            </Label>
                            <Input
                                id="cj-tz"
                                value={timezone}
                                onChange={(e) => setTimezone(e.target.value)}
                                placeholder="Europe/Amsterdam"
                            />
                        </div>

                        <div className="grid gap-1">
                            <Label className="text-xs text-muted-foreground">Status</Label>
                            <Select
                                value={status}
                                onValueChange={(v) => setStatus(v as "active" | "paused")}
                            >
                                <SelectTrigger className="w-full cursor-pointer">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="active" className="cursor-pointer">Active</SelectItem>
                                    <SelectItem value="paused" className="cursor-pointer">Paused</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    {error && <p className="text-xs text-destructive">{error}</p>}
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        className="cursor-pointer"
                        onClick={onClose}
                        disabled={pending}
                    >
                        Cancel
                    </Button>
                    <Button
                        className="cursor-pointer disabled:cursor-not-allowed"
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                    >
                        {pending ? "Saving..." : mode === "create" ? "Create" : "Save"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
