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

function extractAssistantText(message: UIMessage): string {
    return message.parts
        .filter((part) => part.type === "text")
        .map((part) => ("text" in part ? part.text : ""))
        .join("");
}

type SubagentPanelEvent = {
    phase: "started" | "tool_call" | "tool_result";
    text: string;
};

type SubagentPanelPart = {
    type: "subagent-panel";
    taskId: string;
    sessionId: string;
    agentName?: string;
    status: "running" | "completed";
    events: SubagentPanelEvent[];
    text: string;
};

function parseSubagentSpeaker(text: string): { agentName: string } | null {
    const match = text.match(/^Subagent\s+([^:\n]+):/i);
    if (!match || !match[1]) {
        return null;
    }

    return { agentName: match[1].trim() };
}

function parseSubagentPanelPart(value: unknown): SubagentPanelPart | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    const raw = value as Record<string, unknown>;
    if (raw.type !== "subagent-panel") {
        return null;
    }
    if (typeof raw.taskId !== "string" || typeof raw.sessionId !== "string") {
        return null;
    }

    const events: SubagentPanelEvent[] = Array.isArray(raw.events)
        ? raw.events
              .filter((entry) => entry && typeof entry === "object")
              .map((entry) => {
                  const record = entry as Record<string, unknown>;
                  const phase: SubagentPanelEvent["phase"] =
                      record.phase === "tool_call" || record.phase === "tool_result"
                          ? record.phase
                          : "started";

                  return {
                      phase: phase,
                      text: typeof record.text === "string" ? record.text : "",
                  };
              })
              .filter((event) => event.text.trim().length > 0)
        : [];

    return {
        type: "subagent-panel",
        taskId: raw.taskId,
        sessionId: raw.sessionId,
        agentName: typeof raw.agentName === "string" ? raw.agentName : undefined,
        status: raw.status === "completed" ? "completed" : "running",
        events: events,
        text: typeof raw.text === "string" ? raw.text : "",
    };
}

function initialsFromName(name: string): string {
    const parts = name
        .split(/[^a-zA-Z0-9]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    if (parts.length === 0) return "S";

    return parts
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("");
}

function colorFromName(name: string): string {
    const palette = [
        "#14b8a6",
        "#22c55e",
        "#3b82f6",
        "#06b6d4",
        "#f59e0b",
        "#ef4444",
        "#8b5cf6",
        "#f97316",
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) {
        hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }

    return palette[hash % palette.length];
}

export function TestTab({
    activeDeployment,
    deploymentApiKey,
    publicAccessEnabled,
    webSocketEnabled,
    nodeColor,
}: {
    activeDeployment: Doc<"agentDeployments"> | undefined;
    deploymentApiKey?: string;
    publicAccessEnabled: boolean;
    webSocketEnabled: boolean;
    nodeColor?: string;
}) {
    if (!publicAccessEnabled) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Public access is disabled. Enable it in Details to test this agent.
                </p>
            </div>
        );
    }
    if (!activeDeployment) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    No active deployment endpoint yet.
                </p>
            </div>
        );
    }
    if (!deploymentApiKey) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    This deployment does not expose a stored API key in the UI. Reuse the key captured at deployment time, or reissue one from the backend before using the test panel.
                </p>
            </div>
        );
    }

    return (
        <ChatWindow
            endpointId={activeDeployment.endpointId}
            apiKey={deploymentApiKey}
            projectSlug={activeDeployment.projectSlug}
            nodeColor={nodeColor}
            environmentSlug={activeDeployment.environmentSlug}
            webSocketEnabled={webSocketEnabled}
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
    webSocketEnabled,
}: {
    endpointId: string;
    apiKey: string;
    projectSlug?: string;
    nodeColor?: string;
    environmentSlug?: string;
    webSocketEnabled: boolean;
}) {
    const { messages, status, error, sendMessage, resetChat } = useAgentChat({
        endpointId: endpointId,
        apiKey: apiKey,
        projectSlug: projectSlug,
        environmentSlug: environmentSlug,
        webSocketEnabled: webSocketEnabled,
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
function AgentAvatar({ color, className, label }: { color?: string; className?: string; label?: string }) {
    return (
        <span
            className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full ${className ?? ""}`}
            style={{ backgroundColor: color ?? "rgb(168, 85, 247)" }}
        >
            {label && (
                <span className="text-[9px] font-semibold leading-none text-white">
                    {label}
                </span>
            )}
        </span>
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

    const panelPartInMessage =
        message.parts
            .map((part) => parseSubagentPanelPart(part))
            .find((part): part is SubagentPanelPart => part !== null) ?? null;
    const assistantText = extractAssistantText(message);
    const subagentSpeaker = panelPartInMessage?.agentName
        ? { agentName: panelPartInMessage.agentName }
        : parseSubagentSpeaker(assistantText);
    const avatarColor = subagentSpeaker ? colorFromName(subagentSpeaker.agentName) : nodeColor;
    const avatarLabel = subagentSpeaker ? initialsFromName(subagentSpeaker.agentName) : "";
    const firstTextPartIndex = message.parts.findIndex((part) => part.type === "text");

    // Render all parts in order for assistant messages
    return (
        <div className="flex items-start gap-2">
            <AgentAvatar color={avatarColor} label={avatarLabel} />
            <div className="min-w-0 flex-1 space-y-2">
                {subagentSpeaker && !panelPartInMessage && (
                    <p className="text-xs font-medium text-muted-foreground">
                        Subagent {subagentSpeaker.agentName}
                    </p>
                )}
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

                    if (type === "subagent-panel") {
                        const panelPart = parseSubagentPanelPart(p);
                        if (!panelPart) {
                            return null;
                        }

                        return (
                            <SubagentPanelBlock
                                key={`subagent-panel-${panelPart.taskId}`}
                                agentName={panelPart.agentName}
                                status={panelPart.status}
                                events={panelPart.events}
                                text={panelPart.text}
                            />
                        );
                    }

                    // Text content
                    if (type === "text") {
                        let text = typeof p.text === "string" ? p.text : "";
                        if (subagentSpeaker && index === firstTextPartIndex) {
                            const stripped = text.replace(/^Subagent\s+[^:\n]+:\s*/i, "");
                            text = stripped;
                        }

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

function SubagentPanelBlock({
    agentName,
    status,
    events,
    text,
}: {
    agentName?: string;
    status: "running" | "completed";
    events: SubagentPanelEvent[];
    text: string;
}) {
    const isStreaming = status === "running";
    const elapsed = useElapsedTime(isStreaming);
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (contentRef.current) {
            contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
    }, [events, text, isStreaming]);

    // null = user hasn't interacted, follow derived state. Non-null = user override.
    const [userOverride, setUserOverride] = useState<boolean | null>(null);
    const open = userOverride ?? isStreaming;

    return (
        <Collapsible open={open} onOpenChange={setUserOverride}>
            <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/5 px-2 py-1.5 text-xs hover:bg-cyan-500/10 transition-colors">
                <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                <Wrench className="size-3 shrink-0" />
                <span className="font-medium text-foreground">
                    {agentName ? `Subagent ${agentName}` : "Subagent"}
                </span>
                <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                    {isStreaming ? "running..." : "done"}
                    <span className="tabular-nums">{formatElapsed(elapsed)}</span>
                </span>
                {isStreaming && (
                    <Loader2 className="size-3 animate-spin text-muted-foreground" />
                )}
            </CollapsibleTrigger>
            <CollapsibleContent>
                <div ref={contentRef} className="ml-5 mt-1 max-h-40 space-y-2 overflow-y-auto overflow-x-auto rounded-md border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-2">
                    {events.length > 0 && (
                        <div className="space-y-1">
                            {events.map((event, index) => (
                                <p
                                    key={`subagent-event-${index}`}
                                    className="text-[11px] text-cyan-200/90 break-words"
                                >
                                    {event.text}
                                </p>
                            ))}
                        </div>
                    )}
                    {text.trim().length > 0 && (
                        <Streamdown className="min-w-0 break-words text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:whitespace-pre-wrap [&_code]:wrap-break-word [&_pre]:max-w-full [&_pre]:overflow-x-auto">
                            {text}
                        </Streamdown>
                    )}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}

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
