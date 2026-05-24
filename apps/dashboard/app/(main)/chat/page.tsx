"use client";

/**
 * Chat page. Streams a conversation against filthy-panty's harness via the
 * /api/agent/stream proxy route. Agent selector pulls from the org's
 * filthy-panty agents (synced via Convex submodule).
 */

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/app/components/ui/select";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { RotateCcw, Send } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFilthyPantyChat } from "@/app/hooks/useFilthyPantyChat";

export default function ChatPage() {
    const account = useQuery(api.org.getActiveAccount, {});
    const agents = useQuery(api.agents.listForActiveOrg, {});
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [input, setInput] = useState("");
    const bottomRef = useRef<HTMLDivElement>(null);

    // Derive the active agent id: explicit selection wins, else default to the
    // first agent. Computed in render rather than synced via useEffect+setState
    // to avoid the cascading-render lint rule.
    const agentId = useMemo<string | null>(() => {
        if (selectedAgentId) return selectedAgentId;
        if (agents && agents.length > 0) return agents[0]._id as unknown as string;
        return null;
    }, [selectedAgentId, agents]);

    const { messages, status, error, sendMessage, reset } = useFilthyPantyChat({
        agentId: agentId,
    });

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!input.trim() || status === "streaming") return;
        sendMessage(input);
        setInput("");
    }

    const accountReady = account && account.status === "active";
    const hasAgents = agents && agents.length > 0;

    return (
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-8 pt-9 pb-6">
            <div className="flex items-center justify-between pb-4">
                <div>
                    <h2 className="text-xl font-semibold text-foreground">Chat</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Talk to an agent running on filthy-panty.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Select
                        value={agentId ?? ""}
                        onValueChange={(v) => setSelectedAgentId(v)}
                        disabled={!hasAgents}
                    >
                        <SelectTrigger className="w-56 cursor-pointer disabled:cursor-not-allowed">
                            <SelectValue placeholder={hasAgents ? "Select agent" : "No agents"} />
                        </SelectTrigger>
                        <SelectContent>
                            {agents?.map((a) => (
                                <SelectItem
                                    key={a._id as unknown as string}
                                    value={a._id as unknown as string}
                                    className="cursor-pointer"
                                >
                                    {a.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="cursor-pointer disabled:cursor-not-allowed"
                        onClick={reset}
                        disabled={messages.length === 0 || status === "streaming"}
                        title="Reset conversation"
                    >
                        <RotateCcw className="size-4" />
                    </Button>
                </div>
            </div>

            {!accountReady ? (
                <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                    <p className="text-sm text-muted-foreground">
                        Provision your org&apos;s filthy-panty account in{" "}
                        <Link href="/settings/org" className="underline cursor-pointer">
                            Org settings
                        </Link>{" "}
                        before chatting.
                    </p>
                </div>
            ) : !hasAgents ? (
                <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                    <p className="text-sm text-muted-foreground">
                        No agents found for this org. Create one via the filthy-panty API
                        or the cherry-coke canvas first.
                    </p>
                </div>
            ) : (
                <>
                    <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-border bg-card p-4">
                        {messages.length === 0 && (
                            <p className="text-center text-xs text-muted-foreground pt-8">
                                Send a message to start the conversation.
                            </p>
                        )}
                        {messages.map((m) => (
                            <div
                                key={m.id}
                                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                            >
                                <div
                                    className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                                        m.role === "user"
                                            ? "bg-primary text-primary-foreground"
                                            : "bg-muted text-foreground"
                                    }`}
                                >
                                    {m.text || (status === "streaming" ? "…" : "")}
                                </div>
                            </div>
                        ))}
                        <div ref={bottomRef} />
                    </div>

                    {error && (
                        <p className="mt-2 text-xs text-destructive">{error.message}</p>
                    )}

                    <form onSubmit={handleSubmit} className="mt-4 flex items-center gap-2">
                        <Input
                            placeholder="Message…"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            disabled={status === "streaming"}
                            className="disabled:cursor-not-allowed"
                        />
                        <Button
                            type="submit"
                            size="icon"
                            className="cursor-pointer disabled:cursor-not-allowed"
                            disabled={!input.trim() || status === "streaming"}
                        >
                            <Send className="size-4" />
                        </Button>
                    </form>
                </>
            )}
        </div>
    );
}
