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
import { useNow } from "@/app/hooks/useNow";
import { useStickToBottom } from "@/app/hooks/useStickToBottom";
import type { UIMessage } from "ai";
import {
  ArrowUp,
  ChevronRight,
  RotateCcw,
  Terminal,
  Wrench,
} from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
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

// Time since `isActive` last turned on, held once it turns off.
function useElapsedTime(isActive: boolean): number {
  const now = useNow(isActive ? 100 : null);
  const [start, setStart] = useState(() => (isActive ? Date.now() : null));
  const [wasActive, setWasActive] = useState(isActive);
  if (isActive !== wasActive) {
    setWasActive(isActive);
    if (isActive) setStart(Date.now());
  }

  return start === null ? 0 : Math.max(0, now - start);
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
  });
  const [input, setInput] = useState("");
  const followRef = useRef(true);
  const hasAssistantMessage = messages.some((m) => m.role === "assistant");
  const awaitingAnswer = status === "ready" && pendingQuestions.length > 0;
  // A message typed while a question waits would steer the run and leave it open.
  const composerLocked = status === "streaming" || awaitingAnswer;
  const listRef = useStickToBottom<HTMLDivElement>(
    [messages, awaitingAnswer],
    () => followRef.current,
  );

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
    <div
      className="flex flex-1 flex-col overflow-hidden"
      data-chat-state={awaitingAnswer ? "awaiting-answer" : status}
    >
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
                  onClick={() => {
                    // An emptied list fires no scroll event, so follow must be re-armed here.
                    followRef.current = true;
                    resetChat();
                  }}
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
  label,
}: {
  color?: string;
  label?: string;
}): React.JSX.Element {
  return (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-(--avatar-color)"
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

  const assistantText = extractAssistantText(message);
  const subagentSpeaker = parseSubagentSpeaker(assistantText);
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
        {subagentSpeaker && (
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
                input={p.input ?? {}}
                output={hasOutput ? (errorText ?? p.output ?? null) : undefined}
                state={state}
                isError={state === "output-error"}
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

function ReasoningBlock({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}): React.JSX.Element {
  const elapsed = useElapsedTime(isStreaming);
  const preRef = useStickToBottom<HTMLPreElement>(
    [text, isStreaming],
    () => isStreaming,
  );

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
