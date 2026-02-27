"use client";

/** Test tab with a streaming chat window for testing a deployed agent. */
import {
    InputGroup,
    InputGroupAddon,
    InputGroupButton,
    InputGroupTextarea,
} from "@/app/components/ui/input-group";
import type { Doc } from "@/convex/_generated/dataModel";
import { useAgentChat } from "@/hooks/useAgentChat";
import type { UIMessage } from "ai";
import { ArrowUp, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

export function TestTab({
    activeDeployment,
    nodeColor,
}: {
    activeDeployment: Doc<"agentDeployments"> | undefined;
    nodeColor?: string;
}) {
    if (!activeDeployment || !activeDeployment.apiKey) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    No active deployment. Deploy the agent to test it.
                </p>
            </div>
        );
    }

    return (
        <ChatWindow
            endpointId={activeDeployment.endpointId}
            apiKey={activeDeployment.apiKey}
            nodeColor={nodeColor}
        />
    );
}

/** Chat window that streams messages from the agent gateway. */
function ChatWindow({
    endpointId,
    apiKey,
    nodeColor,
}: {
    endpointId: string;
    apiKey: string;
    nodeColor?: string;
}) {
    const { messages, status, error, sendMessage, resetChat } = useAgentChat({
        endpointId: endpointId,
        apiKey: apiKey,
    });
    const [input, setInput] = useState("");
    const bottomRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!input.trim() || status === "streaming") return;
        sendMessage(input);
        setInput("");
    }

    return (
        <div className="flex flex-1 flex-col overflow-hidden">
            {/* Message list */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.length === 0 && (
                    <p className="text-center text-xs text-muted-foreground pt-8">
                        Send a message to test the agent.
                    </p>
                )}
                {messages.map((msg, i) => (
                    <MessageBubble key={msg.id || i} message={msg} nodeColor={nodeColor} />
                ))}
                {status === "streaming" &&
                    !messages.some((m) => m.role === "assistant") && (
                        <ThinkingIndicator nodeColor={nodeColor} />
                    )}
                {error && (
                    <p className="text-xs text-destructive">{error.message}</p>
                )}
                <div ref={bottomRef} />
            </div>

            {/* Input bar */}
            <form
                onSubmit={handleSubmit}
                className="shrink-0 p-3"
            >
                <InputGroup className="rounded-lg">
                    <InputGroupTextarea
                        value={input}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                            setInput(e.target.value)
                        }
                        onKeyDown={(
                            e: React.KeyboardEvent<HTMLTextAreaElement>,
                        ) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                if (input.trim() && status !== "streaming") {
                                    handleSubmit(e);
                                }
                            }
                        }}
                        placeholder="Message..."
                        disabled={status === "streaming"}
                        rows={1}
                        className="max-h-40 min-h-0 py-2.5 text-sm"
                    />
                    <InputGroupAddon align="block-end" className="pt-0">
                        <div className="flex w-full items-center justify-between">
                            <InputGroupButton
                                size="icon-xs"
                                variant="ghost"
                                onClick={resetChat}
                                title="New chat"
                            >
                                <RotateCcw className="size-3.5" />
                            </InputGroupButton>
                            <InputGroupButton
                                type="submit"
                                size="icon-xs"
                                variant="default"
                                disabled={
                                    !input.trim() || status === "streaming"
                                }
                                className="rounded-sm"
                            >
                                {status === "streaming" ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                    <ArrowUp className="size-3.5" />
                                )}
                            </InputGroupButton>
                        </div>
                    </InputGroupAddon>
                </InputGroup>
            </form>
        </div>
    );
}

/** Colored circle avatar matching the agent node on the canvas. */
function AgentAvatar({ color, className }: { color?: string; className?: string }) {
    return (
        <span
            className={`inline-block size-5 shrink-0 rounded-full ${className ?? ""}`}
            style={{ backgroundColor: color ?? "rgb(168, 85, 247)" }}
        />
    );
}

/** Renders a single chat message. User messages are bubbles, assistant messages are full-width markdown. */
function MessageBubble({ message, nodeColor }: { message: UIMessage; nodeColor?: string }) {
    const isUser = message.role === "user";
    const text = message.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground whitespace-pre-wrap">
                    {text}
                </div>
            </div>
        );
    }

    return (
        <div className="flex items-start gap-2">
            <AgentAvatar color={nodeColor} />
            <Streamdown className="min-w-0 text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:whitespace-pre-wrap [&_code]:wrap-break-word [&_pre]:max-w-full [&_pre]:overflow-x-auto">
                {text}
            </Streamdown>
        </div>
    );
}

/** Animated thinking dots shown while waiting for the first assistant chunk. */
function ThinkingIndicator({ nodeColor }: { nodeColor?: string }) {
    return (
        <div className="flex items-start gap-2">
            <AgentAvatar color={nodeColor} className="animate-pulse" />
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <span className="animate-pulse">Thinking</span>
                <span className="inline-flex">
                    <span className="animate-bounce [animation-delay:0ms]">.</span>
                    <span className="animate-bounce [animation-delay:150ms]">.</span>
                    <span className="animate-bounce [animation-delay:300ms]">.</span>
                </span>
            </div>
        </div>
    );
}
