"use client";

import { IconTooltip } from "@/app/components/IconTooltip";
import type { StageDeployment } from "@/app/components/side-panel/DetailsTab";
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
import { QuestionCard } from "@/app/components/side-panel/QuestionCard";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { useAgentChat } from "@/app/hooks/useAgentChat";
import type { UIMessage } from "ai";
import {
  ArrowUp,
  ChevronRight,
  RotateCcw,
  Terminal,
  Wrench,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import * as z from "zod/mini";

// AI SDK ToolResultOutput: a "content" result and its image part.
const contentToolOutput = z.looseObject({
  type: z.literal("content"),
  value: z.array(z.unknown()),
});
const toolImagePart = z.object({
  type: z.literal("image-data"),
  data: z.string(),
  mediaType: z.string(),
});

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

export function TestTab({
  activeDeployment,
  deploymentApiKey,
  agentId,
  nodeColor,
}: {
  activeDeployment: StageDeployment | undefined;
  deploymentApiKey?: string;
  agentId: string;
  nodeColor?: string;
}): React.JSX.Element {
  if (!activeDeployment) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          No runtime key for this stage yet. Generate one in Details to test
          this agent.
        </p>
      </div>
    );
  }
  if (!agentId) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          Save this agent before testing it.
        </p>
      </div>
    );
  }
  if (!deploymentApiKey) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          Loading the encrypted runtime key…
        </p>
      </div>
    );
  }

  return (
    <ChatWindow
      endpointId={activeDeployment.endpointId}
      agentId={agentId}
      apiKey={deploymentApiKey}
      projectSlug={activeDeployment.projectSlug}
      nodeColor={nodeColor}
      stageSlug={activeDeployment.stageSlug}
    />
  );
}

function useElapsedTime(isActive: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- a 100 ms interval timer
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

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function extractAssistantText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("");
}

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
    "var(--color-avatar-1)",
    "var(--color-avatar-2)",
    "var(--color-avatar-3)",
    "var(--color-avatar-4)",
    "var(--color-avatar-5)",
    "var(--color-avatar-6)",
    "var(--color-avatar-7)",
    "var(--color-avatar-8)",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }

  return palette[hash % palette.length];
}

function ChatWindow({
  endpointId,
  agentId,
  apiKey,
  projectSlug,
  nodeColor,
  stageSlug,
}: {
  endpointId: string;
  agentId: string;
  apiKey: string;
  projectSlug?: string;
  nodeColor?: string;
  stageSlug?: string;
}): React.JSX.Element {
  const {
    messages,
    status,
    error,
    pendingQuestions,
    sendMessage,
    answerQuestions,
    resetChat,
  } = useAgentChat({
    endpointId: endpointId,
    agentId: agentId,
    apiKey: apiKey,
    projectSlug: projectSlug,
    stageSlug: stageSlug,
    webSocketEnabled: true,
  });
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const hasAssistantMessage = messages.some((m) => m.role === "assistant");
  const awaitingAnswer = status === "ready" && pendingQuestions.length > 0;
  // A message typed while a question waits would steer the run and leave it open.
  const composerLocked = status === "streaming" || awaitingAnswer;

  // Instant, not smooth: a smooth scroll restarted per streamed chunk never settles.
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- scrolls the list's DOM node
  useEffect(() => {
    const list = listRef.current;
    if (list && followRef.current) list.scrollTop = list.scrollHeight;
  }, [messages, awaitingAnswer]);

  useShortcut("panel.send", send);

  function send(): void {
    if (!input.trim() || composerLocked) return;
    void sendMessage(input);
    setInput("");
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    send();
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        ref={listRef}
        onScroll={(e) => {
          const list = e.currentTarget;
          followRef.current =
            list.scrollHeight - list.scrollTop - list.clientHeight < 48;
        }}
        className="flex-1 overflow-y-auto p-4 space-y-4"
      >
        {messages.length === 0 && (
          <p className="text-center text-xs text-muted-foreground pt-8">
            Send a message to test the agent.
          </p>
        )}
        {messages.map((msg, i) => (
          <MessageBubble
            key={msg.id || i}
            message={msg}
            nodeColor={nodeColor}
          />
        ))}
        {status === "streaming" && !hasAssistantMessage && (
          <ThinkingIndicator nodeColor={nodeColor} />
        )}
        {awaitingAnswer && (
          <QuestionCard prompts={pendingQuestions} onAnswer={answerQuestions} />
        )}
        {error && <p className="text-xs text-destructive">{error.message}</p>}
      </div>

      <form onSubmit={handleSubmit} className="shrink-0 p-3">
        <InputGroup className="rounded-lg">
          <InputGroupTextarea
            aria-label="Message"
            value={input}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setInput(e.target.value)
            }
            onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (input.trim() && !composerLocked) {
                  void sendMessage(input);
                  setInput("");
                }
              }
            }}
            placeholder={
              awaitingAnswer
                ? "Answer the question above to continue"
                : "Message..."
            }
            disabled={composerLocked}
            rows={1}
            className="max-h-40 min-h-0 py-2.5 text-sm"
          />
          <InputGroupAddon align="block-end" className="pt-0">
            <div className="flex w-full items-center justify-between">
              <IconTooltip label="New chat">
                <InputGroupButton
                  size="icon-xs"
                  variant="ghost"
                  className="cursor-pointer"
                  onClick={resetChat}
                >
                  <RotateCcw className="size-3.5" />
                </InputGroupButton>
              </IconTooltip>
              <IconTooltip label="Send">
                <InputGroupButton
                  type="submit"
                  size="icon-xs"
                  variant="default"
                  disabled={!input.trim() || composerLocked}
                  className="cursor-pointer rounded-sm"
                >
                  <ArrowUp className="size-3.5" />
                </InputGroupButton>
              </IconTooltip>
            </div>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}

function AgentAvatar({
  color,
  className,
  label,
}: {
  color?: string;
  className?: string;
  label?: string;
}): React.JSX.Element {
  return (
    <span
      className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-(--avatar-color) ${className ?? ""}`}
      style={{ "--avatar-color": color ?? "var(--color-canvas-agent)" }}
    >
      {label && (
        <span className="text-3xs font-semibold leading-none text-white">
          {label}
        </span>
      )}
    </span>
  );
}

function splitToolImages(output: unknown): { images: string[]; rest: unknown } {
  const content = contentToolOutput.safeParse(output);
  if (!content.success) {
    return { images: [], rest: output };
  }
  const images: string[] = [];
  const rest: unknown[] = [];
  for (const part of content.data.value) {
    const image = toolImagePart.safeParse(part);
    if (image.success) {
      images.push(`data:${image.data.mediaType};base64,${image.data.data}`);
    } else {
      rest.push(part);
    }
  }

  return { images: images, rest: { ...content.data, value: rest } };
}

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

function getToolName(part: Record<string, unknown>): string {
  if (typeof part.toolName === "string" && part.toolName.trim().length > 0) {
    return part.toolName;
  }

  const rawType = typeof part.type === "string" ? part.type : "";
  const derived = rawType.replace(/^tool-/, "");

  return derived || "unknown";
}

function isToolOutputState(state: string): boolean {
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

const MessageBubble = memo(function MessageBubble({
  message,
  nodeColor,
}: {
  message: UIMessage;
  nodeColor?: string;
}): React.JSX.Element {
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
  const avatarColor = subagentSpeaker
    ? colorFromName(subagentSpeaker.agentName)
    : nodeColor;
  const avatarLabel = subagentSpeaker
    ? initialsFromName(subagentSpeaker.agentName)
    : "";
  const firstTextPartIndex = message.parts.findIndex(
    (part) => part.type === "text",
  );

  return (
    <div className="flex items-start gap-2">
      <AgentAvatar color={avatarColor} label={avatarLabel} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {subagentSpeaker && !panelPartInMessage && (
          <p className="text-xs font-medium text-muted-foreground">
            Subagent {subagentSpeaker.agentName}
          </p>
        )}
        {message.parts.map((part, index) => {
          const p = part as unknown as Record<string, unknown>;
          const type = typeof p.type === "string" ? p.type : "";

          if (type === "reasoning") {
            const text = typeof p.text === "string" ? p.text : "";
            const state = typeof p.state === "string" ? p.state : "done";

            return (
              <ReasoningBlock
                // oxlint-disable-next-line react/no-array-index-key -- append-only parts, no id
                key={`reasoning-${index}`}
                text={text}
                isStreaming={state === "streaming"}
              />
            );
          }

          if (type === "dynamic-tool" || type.startsWith("tool-")) {
            const state = typeof p.state === "string" ? p.state : "";
            const toolName = getToolName(p);
            const hasOutput = isToolOutputState(state);
            const errorText =
              typeof p.errorText === "string" ? p.errorText : null;

            return (
              <ToolInvocationBlock
                key={`tool-${typeof p.toolCallId === "string" ? p.toolCallId : index}`}
                toolName={toolName}
                input={p.input ?? p.args ?? {}}
                output={
                  hasOutput
                    ? (errorText ?? p.output ?? p.result ?? null)
                    : undefined
                }
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

          if (type === "text") {
            let text = typeof p.text === "string" ? p.text : "";
            if (subagentSpeaker && index === firstTextPartIndex) {
              const stripped = text.replace(/^Subagent\s+[^:\n]+:\s*/i, "");
              text = stripped;
            }

            if (text.trim().length === 0) return null;

            return (
              <Streamdown
                // oxlint-disable-next-line react/no-array-index-key -- append-only parts, no id
                key={`text-${index}`}
                className="min-w-0 text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:whitespace-pre-wrap [&_code]:wrap-break-word [&_pre]:max-w-full [&_pre]:overflow-x-auto"
              >
                {text}
              </Streamdown>
            );
          }

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
}): React.JSX.Element {
  const isStreaming = status === "running";
  const elapsed = useElapsedTime(isStreaming);
  const contentRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- scrolls the panel's DOM node
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [events, text, isStreaming]);

  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const open = userOverride ?? isStreaming;

  return (
    <Collapsible open={open} onOpenChange={setUserOverride}>
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 rounded-md border border-run-subagent/30 bg-run-subagent/5 px-2 py-1.5 text-xs hover:bg-run-subagent/10 transition-colors">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90" />
        <Wrench className="size-3 shrink-0" />
        <span className="font-medium text-foreground">
          {agentName ? `Subagent ${agentName}` : "Subagent"}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
          {isStreaming ? "running..." : "done"}
          <span className="tabular-nums">{formatElapsed(elapsed)}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          ref={contentRef}
          className="ml-5 mt-1 max-h-40 space-y-2 overflow-y-auto overflow-x-auto rounded-md border border-run-subagent/20 bg-run-subagent/5 px-2.5 py-2"
        >
          {events.length > 0 && (
            <div className="flex flex-col gap-1">
              {events.map((event, index) => (
                <p
                  // oxlint-disable-next-line react/no-array-index-key -- append-only events, no id
                  key={`subagent-event-${index}`}
                  className="text-2xs text-run-subagent wrap-break-word"
                >
                  {event.text}
                </p>
              ))}
            </div>
          )}
          {text.trim().length > 0 && (
            <Streamdown className="min-w-0 wrap-break-word text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:whitespace-pre-wrap [&_code]:wrap-break-word [&_pre]:max-w-full [&_pre]:overflow-x-auto">
              {text}
            </Streamdown>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ReasoningBlock({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}): React.JSX.Element {
  const elapsed = useElapsedTime(isStreaming);
  const preRef = useRef<HTMLPreElement>(null);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- scrolls the reasoning's DOM node
  useEffect(() => {
    if (isStreaming && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [text, isStreaming]);

  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const open = userOverride ?? isStreaming;

  return (
    <Collapsible open={open} onOpenChange={setUserOverride}>
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 transition-colors">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90" />
        <span className="font-medium">
          {isStreaming ? "Thinking..." : "Thinking"}
        </span>
        <span className="ml-auto tabular-nums">{formatElapsed(elapsed)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 mt-1 rounded-md border border-run-reasoning/20 bg-run-reasoning/5 px-2.5 py-2">
          <pre
            ref={preRef}
            className="max-h-40 max-w-full overflow-y-auto overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-xs text-muted-foreground"
          >
            {text || "..."}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolInvocationBlock({
  toolName,
  input,
  output,
  state,
  isError,
}: {
  toolName: string;
  input: unknown;
  output: unknown;
  state: string;
  isError: boolean;
}): React.JSX.Element {
  const hasOutput = output !== undefined;
  // Re-rendered per streamed chunk, and a screenshot's data URL is hundreds of KB.
  const result = useMemo(() => splitToolImages(output), [output]);
  const isRunning = state === "input-available" || state === "input-streaming";
  const elapsed = useElapsedTime(isRunning);

  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const open = userOverride ?? !hasOutput;

  return (
    <Collapsible open={open} onOpenChange={setUserOverride}>
      <CollapsibleTrigger
        className={`group flex w-full cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors ${
          isError
            ? "border-destructive/30 bg-destructive/5 hover:bg-destructive/10"
            : hasOutput
              ? "border-success/30 bg-success/5 hover:bg-success/10"
              : "border-info/30 bg-info/5 hover:bg-info/10"
        }`}
      >
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90" />
        <Wrench className="size-3 shrink-0" />
        <span className="font-medium text-foreground">{toolName}</span>
        <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
          {isRunning && "running..."}
          {state === "output-available" && "done"}
          {state === "output-error" && "error"}
          {state === "output-denied" && "denied"}
          <span className="tabular-nums">{formatElapsed(elapsed)}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 mt-1 flex flex-col gap-1.5">
          <div className="rounded-md border border-info/20 bg-info/5 px-2.5 py-2">
            <p className="mb-1 flex items-center gap-1 text-3xs font-medium uppercase tracking-wider text-info">
              <Terminal className="size-2.5" />
              Request
            </p>
            <pre className="max-h-40 max-w-full overflow-y-auto overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-xs text-foreground">
              {formatToolValue(input)}
            </pre>
          </div>

          {hasOutput && (
            <div
              className={`rounded-md border px-2.5 py-2 ${
                isError
                  ? "border-destructive/20 bg-destructive/5"
                  : "border-success/20 bg-success/5"
              }`}
            >
              <p
                className={`mb-1 flex items-center gap-1 text-3xs font-medium uppercase tracking-wider ${
                  isError ? "text-destructive" : "text-success"
                }`}
              >
                <Terminal className="size-2.5" />
                {isError ? "Error" : "Result"}
              </p>
              {result.images.map((src, index) => (
                // oxlint-disable-next-line nextjs/no-img-element -- a data URL: nothing to optimize
                <img
                  // oxlint-disable-next-line react/no-array-index-key -- fixed result images
                  key={index}
                  src={src}
                  alt={`${toolName} result ${index + 1}`}
                  className="mb-1.5 max-h-64 w-auto rounded-md border"
                />
              ))}
              <pre className="max-h-40 max-w-full overflow-y-auto overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-xs text-foreground">
                {formatToolValue(result.rest)}
              </pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ThinkingIndicator({
  nodeColor,
}: {
  nodeColor?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <AgentAvatar color={nodeColor} />
      <div className="text-sm text-muted-foreground">Thinking...</div>
    </div>
  );
}
