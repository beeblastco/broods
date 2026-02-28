"use client";

/** Test tab with a streaming chat window for testing a deployed agent. */
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/app/components/ui/collapsible";
import {
    InputGroup,
    InputGroupAddon,
    InputGroupButton,
    InputGroupTextarea,
} from "@/app/components/ui/input-group";
import { useAgentChat } from "@/app/hooks/useAgentChat";
import type { Doc } from "@/convex/_generated/dataModel";
import type { UIMessage } from "ai";
import {
    ArrowUp,
    ChevronRight,
    Loader2,
    RotateCcw,
    Terminal,
    Wrench,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

/**
 * Tracks elapsed time in ms while isActive is true.
 * Freezes the value once isActive becomes false.
 */
function useElapsedTime(isActive: boolean): number {
    const [elapsed, setElapsed] = useState(0);
    const startRef = useRef(0);

    useEffect(() => {
        if (!isActive) return;
        startRef.current = Date.now();
        const id = setInterval(() => {
            setElapsed(Date.now() - startRef.current);
        }, 100);

        return () => clearInterval(id);
    }, [isActive]);

    return elapsed;
}

/** Formats milliseconds as a compact duration string (e.g. "1.2s"). */
function formatElapsed(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

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
            projectSlug={activeDeployment.projectSlug}
            nodeColor={nodeColor}
            environmentSlug={activeDeployment.environmentSlug}
        />
    );
}

/** Chat window that streams messages from the agent gateway. */
function ChatWindow({
    endpointId,
    apiKey,
    projectSlug,
    nodeColor,
    environmentSlug,
}: {
    endpointId: string;
    apiKey: string;
    projectSlug?: string;
    nodeColor?: string;
    environmentSlug?: string;
}) {
    const { messages, status, error, sendMessage, resetChat } = useAgentChat({
        endpointId: endpointId,
        apiKey: apiKey,
        projectSlug: projectSlug,
        environmentSlug: environmentSlug,
    });
    const [input, setInput] = useState("");
    const bottomRef = useRef<HTMLDivElement>(null);
    const hasAssistantMessage = messages.some((m) => m.role === "assistant");

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
                {status === "streaming" && !hasAssistantMessage && (
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
                                    sendMessage(input);
                                    setInput("");
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

/** Safely format arbitrary values for rendering inside tool event blocks. */
function formatToolValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

/**
 * Extracts the tool name from a UI message part.
 * Handles both dynamic-tool (has toolName) and typed tool-* parts.
 */
function getToolName(part: Record<string, unknown>): string {
    if (typeof part.toolName === "string" && part.toolName.trim().length > 0) {
        return part.toolName;
    }

    const rawType = typeof part.type === "string" ? part.type : "";
    const derived = rawType.replace(/^tool-/, "");

    return derived || "unknown";
}

/** Checks if a tool part has reached a terminal output state. */
function isToolOutputState(state: string): boolean {
    return state === "output-available" || state === "output-error" || state === "output-denied";
}

/** Renders a single chat message with reasoning, tool, and text parts in order. */
const MessageBubble = memo(function MessageBubble({ message, nodeColor }: { message: UIMessage; nodeColor?: string }) {
    const isUser = message.role === "user";
    const userText = isUser
        ? message.parts
              .filter((p) => p.type === "text")
              .map((p) => ("text" in p ? p.text : ""))
              .join("")
        : "";

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground whitespace-pre-wrap">
                    {userText}
                </div>
            </div>
        );
    }

    // Render all parts in order for assistant messages
    return (
        <div className="flex items-start gap-2">
            <AgentAvatar color={nodeColor} />
            <div className="min-w-0 flex-1 space-y-2">
                {message.parts.map((part, index) => {
                    const p = part as unknown as Record<string, unknown>;
                    const type = typeof p.type === "string" ? p.type : "";

                    // Reasoning / thinking
                    if (type === "reasoning") {
                        const text = typeof p.text === "string" ? p.text : "";
                        const state = typeof p.state === "string" ? p.state : "done";

                        return (
                            <ReasoningBlock
                                key={`reasoning-${index}`}
                                text={text}
                                isStreaming={state === "streaming"}
                            />
                        );
                    }

                    // Tool invocation (typed tool-* or dynamic-tool)
                    if (type === "dynamic-tool" || (type.startsWith("tool-") && type !== "text")) {
                        const state = typeof p.state === "string" ? p.state : "";
                        const toolName = getToolName(p);
                        const hasOutput = isToolOutputState(state);
                        const errorText = typeof p.errorText === "string" ? p.errorText : null;

                        return (
                            <ToolInvocationBlock
                                key={`tool-${typeof p.toolCallId === "string" ? p.toolCallId : index}`}
                                toolName={toolName}
                                input={p.input ?? p.args ?? {}}
                                output={hasOutput ? (errorText ?? p.output ?? p.result ?? null) : undefined}
                                state={state}
                                isError={state === "output-error"}
                            />
                        );
                    }

                    // Text content
                    if (type === "text") {
                        const text = typeof p.text === "string" ? p.text : "";

                        if (text.trim().length === 0) return null;

                        return (
                            <Streamdown
                                key={`text-${index}`}
                                className="min-w-0 text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:whitespace-pre-wrap [&_code]:wrap-break-word [&_pre]:max-w-full [&_pre]:overflow-x-auto"
                            >
                                {text}
                            </Streamdown>
                        );
                    }

                    // Skip step-start and other non-visual parts
                    return null;
                })}
            </div>
        </div>
    );
});

/** Collapsible block showing the model's reasoning/thinking process. */
function ReasoningBlock({ text, isStreaming }: { text: string; isStreaming: boolean }) {
    const elapsed = useElapsedTime(isStreaming);
    const preRef = useRef<HTMLPreElement>(null);

    // Auto-scroll to bottom while streaming new content.
    useEffect(() => {
        if (isStreaming && preRef.current) {
            preRef.current.scrollTop = preRef.current.scrollHeight;
        }
    }, [text, isStreaming]);

    // null = user hasn't interacted, follow derived state. Non-null = user override.
    const [userOverride, setUserOverride] = useState<boolean | null>(null);
    const open = userOverride ?? isStreaming;

    return (
        <Collapsible open={open} onOpenChange={setUserOverride}>
            <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 transition-colors">
                <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                <span className="font-medium">
                    {isStreaming ? "Thinking..." : "Thinking"}
                </span>
                <span className="ml-auto tabular-nums">
                    {formatElapsed(elapsed)}
                </span>
                {isStreaming && (
                    <Loader2 className="size-3 animate-spin" />
                )}
            </CollapsibleTrigger>
            <CollapsibleContent>
                <div className="ml-5 mt-1 rounded-md border border-purple-500/20 bg-purple-500/5 px-2.5 py-2">
                    <pre ref={preRef} className="max-h-40 max-w-full overflow-y-auto overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-xs text-muted-foreground">
                        {text || "..."}
                    </pre>
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}

/** Collapsible block that preserves both tool call request and result. */
function ToolInvocationBlock({
    toolName,
    input,
    output,
    state,
    isError,
}: {
    toolName: string;
    input: unknown;
    output: unknown | undefined;
    state: string;
    isError: boolean;
}) {
    const hasOutput = output !== undefined;
    const isRunning = state === "input-available" || state === "input-streaming";
    const elapsed = useElapsedTime(isRunning);

    // null = user hasn't interacted, follow derived state. Non-null = user override.
    const [userOverride, setUserOverride] = useState<boolean | null>(null);
    const open = userOverride ?? !hasOutput;

    return (
        <Collapsible open={open} onOpenChange={setUserOverride}>
            <CollapsibleTrigger
                className={`group flex w-full items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors ${
                    isError
                        ? "border-red-500/30 bg-red-500/5 hover:bg-red-500/10"
                        : hasOutput
                          ? "border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10"
                          : "border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10"
                }`}
            >
                <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                <Wrench className="size-3 shrink-0" />
                <span className="font-medium text-foreground">{toolName}</span>
                <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                    {isRunning && "running..."}
                    {state === "output-available" && "done"}
                    {state === "output-error" && "error"}
                    {state === "output-denied" && "denied"}
                    <span className="tabular-nums">{formatElapsed(elapsed)}</span>
                </span>
                {isRunning && (
                    <Loader2 className="size-3 animate-spin text-muted-foreground" />
                )}
            </CollapsibleTrigger>
            <CollapsibleContent>
                <div className="ml-5 mt-1 space-y-1.5">
                    {/* Tool call request */}
                    <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-2.5 py-2">
                        <p className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-blue-400">
                            <Terminal className="size-2.5" />
                            Request
                        </p>
                        <pre className="max-h-40 max-w-full overflow-y-auto overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-xs text-foreground">
                            {formatToolValue(input)}
                        </pre>
                    </div>

                    {/* Tool call result (shown once available) */}
                    {hasOutput && (
                        <div
                            className={`rounded-md border px-2.5 py-2 ${
                                isError
                                    ? "border-red-500/20 bg-red-500/5"
                                    : "border-emerald-500/20 bg-emerald-500/5"
                            }`}
                        >
                            <p
                                className={`mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider ${
                                    isError ? "text-red-400" : "text-emerald-400"
                                }`}
                            >
                                <Terminal className="size-2.5" />
                                {isError ? "Error" : "Result"}
                            </p>
                            <pre className="max-h-40 max-w-full overflow-y-auto overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-xs text-foreground">
                                {formatToolValue(output)}
                            </pre>
                        </div>
                    )}
                </div>
            </CollapsibleContent>
        </Collapsible>
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
