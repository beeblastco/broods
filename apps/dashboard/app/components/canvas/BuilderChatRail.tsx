"use client";

/**
 * Chat rail docked beside the canvas. Mounting it provisions the stage in one
 * shot: the Builder agent (`builder.ensureForStage`) and its runtime API key
 * (`agentDeployments.ensureForStage`), so a fresh stage never dead-ends. It
 * then streams against the Builder the same way TestTab streams against a
 * regular deployed agent. Canvas-mutation tool results carry the affected
 * node id, reported to the canvas so it can flash the node the Builder just
 * touched.
 */
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/app/components/ui/input-group";
import { getSkillsBearerToken } from "@/app/lib/skillsCredentials";
import { useAgentChat } from "@/app/hooks/useAgentChat";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { UIMessage } from "ai";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  ArrowUp,
  Bot,
  Check,
  FileText,
  FolderOpen,
  Loader2,
  Plug,
  RotateCcw,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

type BuilderState = { configId: string; agentId: string };

type EnsureResult =
  | { kind: "pending" }
  | { kind: "error"; message: string }
  | { kind: "ready"; builder: BuilderState };
type QuickAddKind = "skill" | "tool" | "workspace";

/** The canvas-mutating builder tools whose results name an affected node. */
const BUILDER_MUTATION_TOOLS = new Set([
  "add_agent",
  "update_node",
  "connect_nodes",
  "remove_node",
  "connect_channel",
]);

/**
 * Pulls the affected node id out of a finished builder tool part's output.
 * The tools return the config plane's op result serialized as JSON:
 * `{ nodeId?, configId?, detail }`.
 */
function nodeIdFromToolPart(part: Record<string, unknown>): string | null {
  const output = part.output ?? part.result;
  if (typeof output !== "string" || output.length === 0) return null;

  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const nodeId = (parsed as Record<string, unknown>).nodeId;

    return typeof nodeId === "string" && nodeId.length > 0 ? nodeId : null;
  } catch {
    return null;
  }
}

function builderSetupErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Could not find public function")) {
    return "Builder is not available in this Convex dev deployment yet. Push the latest Convex functions, then refresh.";
  }

  return message;
}

export function BuilderChatRail({
  projectId,
  stageId,
  onNodeAction,
  onQuickAdd,
}: {
  projectId: Id<"projects">;
  stageId: Id<"stages">;
  onNodeAction?: (nodeId: string) => void;
  onQuickAdd?: (kind: QuickAddKind, label: string) => void;
}): React.JSX.Element {
  // Provision this stage in one shot on rail mount: the Builder agent and the
  // stage's runtime deployment (with its API key). Both mutations are
  // idempotent, so re-mounting is free. The deployment's reactive queries
  // below pick up the freshly created row on their own.
  const ensureBuilder = useMutation(api.builder.ensureForStage);
  const ensureDeployment = useMutation(api.agentDeployments.ensureForStage);
  const [result, setResult] = useState<EnsureResult>({ kind: "pending" });
  // Set when deployment provisioning failed; replaces the generic no-key hint.
  const [deployError, setDeployError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      ensureBuilder({ projectId: projectId, stageId: stageId }),
      ensureDeployment({ projectId: projectId, stageId: stageId }),
    ]).then(([builderOutcome, deployOutcome]) => {
      if (cancelled) return;

      if (deployOutcome.status === "rejected") {
        setDeployError(
          deployOutcome.reason instanceof Error
            ? deployOutcome.reason.message
            : String(deployOutcome.reason),
        );
      }
      if (builderOutcome.status === "rejected") {
        setResult({
          kind: "error",
          message: builderSetupErrorMessage(builderOutcome.reason),
        });

        return;
      }
      setDeployError(null);
      setResult({ kind: "ready", builder: builderOutcome.value });
    });

    return () => {
      cancelled = true;
    };
  }, [ensureBuilder, ensureDeployment, projectId, stageId]);

  // The stage-wide runtime key + endpoint the Builder is reachable through.
  const deployment = useQuery(
    api.agentDeployments.getForStage,
    result.kind === "ready"
      ? { projectId: projectId, stageId: stageId }
      : "skip",
  );
  const apiKey = useQuery(
    api.agentDeployments.revealKeyForStage,
    result.kind === "ready"
      ? { projectId: projectId, stageId: stageId }
      : "skip",
  );

  if (result.kind === "error") {
    return (
      <RailFrame>
        <LocalAgentWorkspace
          setupMessage={result.message}
          onQuickAdd={onQuickAdd}
        />
      </RailFrame>
    );
  }
  if (
    result.kind !== "ready" ||
    deployment === undefined ||
    apiKey === undefined
  ) {
    return (
      <RailFrame>
        <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Waking the Builder…
        </p>
      </RailFrame>
    );
  }
  if (!deployment || !apiKey) {
    return (
      <RailFrame>
        <p className="text-center text-xs text-muted-foreground">
          {deployError ??
            "No runtime API key for this stage yet. Generate one in Details to chat with the Builder."}
        </p>
      </RailFrame>
    );
  }

  return (
    <RailFrame>
      <BuilderChatWindow
        projectId={projectId}
        stageId={stageId}
        endpointId={deployment.endpointId}
        agentId={result.builder.agentId}
        apiKey={apiKey}
        projectSlug={deployment.projectSlug}
        stageSlug={deployment.stageSlug}
        onNodeAction={onNodeAction}
      />
    </RailFrame>
  );
}

/** Fixed-height frame with the rail's header, shared by every body state. */
function RailFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex size-full flex-col overflow-hidden border-l border-border bg-card/40">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
        <Bot className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Builder</span>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-hidden p-4">
        {children}
      </div>
    </div>
  );
}

function BuilderChatWindow({
  projectId,
  stageId,
  endpointId,
  agentId,
  apiKey,
  projectSlug,
  stageSlug,
  onNodeAction,
}: {
  projectId: Id<"projects">;
  stageId: Id<"stages">;
  endpointId: string;
  agentId: string;
  apiKey: string;
  projectSlug?: string;
  stageSlug?: string;
  onNodeAction?: (nodeId: string) => void;
}) {
  const { messages, status, error, sendMessage, resetChat } = useAgentChat({
    endpointId: endpointId,
    agentId: agentId,
    apiKey: apiKey,
    projectSlug: projectSlug,
    stageSlug: stageSlug,
    webSocketEnabled: true,
  });
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const reportedCallsRef = useRef<Set<string>>(new Set());
  const hasAssistantMessage = messages.some((m) => m.role === "assistant");
  const createFromJson = useAction(api.skillsPublic.createFromJson);
  const commitBuilderSkill = useMutation(api.builder.commitBuilderSkill);
  const [skillDraftState, setSkillDraftState] = useState<
    Record<string, "busy" | "done" | "error" | "discarded">
  >({});

  async function handleAcceptSkill(
    toolCallId: string,
    draft: {
      name: string;
      description: string;
      content: string;
      skillPath: string;
    },
  ) {
    const token = getSkillsBearerToken();
    if (!token) {
      setSkillDraftState((prev) => ({ ...prev, [toolCallId]: "error" }));
      return;
    }
    setSkillDraftState((prev) => ({ ...prev, [toolCallId]: "busy" }));
    try {
      const saved = await createFromJson({
        bearerToken: token.trim(),
        name: draft.name,
        description: draft.description.trim(),
        content: draft.content.trim(),
      });
      const result = await commitBuilderSkill({
        projectId: projectId,
        stageId: stageId,
        runtimeAgentId: agentId,
        skillPath: saved.path,
        name: saved.name,
        description: saved.description,
      });
      setSkillDraftState((prev) => ({ ...prev, [toolCallId]: "done" }));
      if (result.nodeId) onNodeAction?.(result.nodeId);
    } catch {
      setSkillDraftState((prev) => ({ ...prev, [toolCallId]: "error" }));
    }
  }

  function handleDiscardSkill(toolCallId: string) {
    setSkillDraftState((prev) => ({
      ...prev,
      [toolCallId]: "discarded",
    }));
  }

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Report each finished canvas-mutation tool call exactly once so the
  // canvas can flash the node the Builder just touched.
  useEffect(() => {
    if (!onNodeAction) return;

    for (const message of messages) {
      message.parts.forEach((part, index) => {
        const record = part as unknown as Record<string, unknown>;
        const type = typeof record.type === "string" ? record.type : "";
        const isToolPart =
          type === "dynamic-tool" ||
          (type.startsWith("tool-") && type !== "text");
        if (!isToolPart) return;

        const state = typeof record.state === "string" ? record.state : "";
        if (
          state !== "output-available" &&
          state !== "output-error" &&
          state !== "output-denied"
        ) {
          return;
        }

        const toolName =
          typeof record.toolName === "string" && record.toolName.length > 0
            ? record.toolName
            : type.replace(/^tool-/, "");
        if (!BUILDER_MUTATION_TOOLS.has(toolName)) return;

        const callKey =
          typeof record.toolCallId === "string" && record.toolCallId.length > 0
            ? record.toolCallId
            : `${message.id}:${index}`;
        if (reportedCallsRef.current.has(callKey)) return;
        reportedCallsRef.current.add(callKey);

        if (state !== "output-available") return;
        const nodeId = nodeIdFromToolPart(record);
        if (nodeId) onNodeAction(nodeId);
      });
    }
  }, [messages, onNodeAction]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || status === "streaming") return;
    sendMessage(input);
    setInput("");
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Message list */}
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="pt-8 text-center text-xs text-muted-foreground">
            Ask the Builder to add agents, wire them together, or rework their
            prompts — watch it happen on the canvas.
          </p>
        )}
        {messages.map((msg, i) => (
          <MessageBubble
            key={msg.id || i}
            message={msg}
            onAcceptSkill={handleAcceptSkill}
            onDiscardSkill={handleDiscardSkill}
            skillDraftState={skillDraftState}
          />
        ))}
        {status === "streaming" && !hasAssistantMessage && (
          <p className="animate-pulse text-xs text-muted-foreground">
            Thinking…
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error.message}</p>}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <form onSubmit={handleSubmit} className="shrink-0 p-3">
        <InputGroup className="rounded-lg">
          <InputGroupTextarea
            value={input}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setInput(e.target.value)
            }
            onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (input.trim() && status !== "streaming") {
                  sendMessage(input);
                  setInput("");
                }
              }
            }}
            placeholder="Tell the Builder what to build…"
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
                disabled={!input.trim() || status === "streaming"}
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

function LocalAgentWorkspace({
  setupMessage,
  onQuickAdd,
}: {
  setupMessage: string;
  onQuickAdd?: (kind: QuickAddKind, label: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<QuickAddKind>("skill");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([
    {
      role: "agent",
      text: "Tell me what this agent should know, connect to, or keep in its folder. I can lay those pieces onto the canvas now.",
    },
  ]);
  const skills = ["Customer triage", "Market research", "Bug report routing"];
  const integrations = ["Slack", "Gmail", "HubSpot"];
  const folders = ["Project brief", "Run logs", "Uploaded files"];

  function add(kind: QuickAddKind, label: string) {
    onQuickAdd?.(kind, label);
    setMessages((prev) => [
      ...prev,
      {
        role: "agent",
        text: `Added ${label} as a ${kind === "tool" ? "connection" : kind} on the canvas. Click the node to edit its details.`,
      },
    ]);
  }

  function submitPrompt() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text: text }]);

    const lower = text.toLowerCase();
    if (lower.includes("integration") || lower.includes("connect")) {
      add("tool", text.replace(/^add\s+/i, "") || "New integration");
    } else if (lower.includes("folder") || lower.includes("file")) {
      add("workspace", text.replace(/^add\s+/i, "") || "Agent folder");
    } else {
      add("skill", text.replace(/^add\s+/i, "") || "New skill");
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    submitPrompt();
  }

  const tabItems = [
    { id: "skill" as const, label: "Skills", icon: Sparkles, items: skills },
    { id: "tool" as const, label: "Connect", icon: Plug, items: integrations },
    {
      id: "workspace" as const,
      label: "Files",
      icon: FolderOpen,
      items: folders,
    },
  ];
  const current = tabItems.find((tab) => tab.id === activeTab) ?? tabItems[0];
  const CurrentIcon = current.icon;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
        {setupMessage}
      </div>

      <div className="mb-3 grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
        {tabItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={`flex h-8 items-center justify-center gap-1 rounded-sm text-[11px] font-medium ${
              activeTab === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="mb-3 rounded-md border border-border bg-background/60 p-2">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium">
          <CurrentIcon className="size-3.5 text-muted-foreground" />
          {current.label}
        </div>
        <div className="space-y-1">
          {current.items.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => add(current.id, item)}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {item}
              <ArrowUp className="size-3 rotate-45" />
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={message.role === "user" ? "flex justify-end" : ""}
          >
            <p
              className={`max-w-[88%] rounded-lg px-3 py-2 text-xs leading-5 ${
                message.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-background"
              }`}
            >
              {message.text}
            </p>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="mt-3 shrink-0">
        <InputGroup className="rounded-lg">
          <InputGroupTextarea
            value={input}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
              setInput(event.target.value)
            }
            onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitPrompt();
              }
            }}
            placeholder="Ask this agent to add a skill, connection, or folder..."
            rows={1}
            className="max-h-28 min-h-0 py-2.5 text-sm"
          />
          <InputGroupAddon align="block-end" className="pt-0">
            <InputGroupButton
              type="submit"
              size="icon-xs"
              variant="default"
              disabled={!input.trim()}
              className="ml-auto rounded-sm"
            >
              <ArrowUp className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}

/** Renders one chat message: user bubble, or assistant text + tool activity. */
function MessageBubble({
  message,
  onAcceptSkill,
  onDiscardSkill,
  skillDraftState,
}: {
  message: UIMessage;
  onAcceptSkill?: (
    toolCallId: string,
    draft: {
      name: string;
      description: string;
      content: string;
      skillPath: string;
    },
  ) => void;
  onDiscardSkill?: (toolCallId: string) => void;
  skillDraftState?: Record<string, "busy" | "done" | "error" | "discarded">;
}) {
  if (message.role === "user") {
    const userText = message.parts
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join("");

    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary px-3 py-1.5 text-sm whitespace-pre-wrap text-primary-foreground">
          {userText}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-purple-500">
        <Bot className="size-3 text-white" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {message.parts.map((part, index) => {
          const record = part as unknown as Record<string, unknown>;
          const type = typeof record.type === "string" ? record.type : "";

          if (type === "text") {
            const text = typeof record.text === "string" ? record.text : "";
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

          const isToolPart =
            type === "dynamic-tool" ||
            (type.startsWith("tool-") && type !== "text");
          if (isToolPart) {
            const state = typeof record.state === "string" ? record.state : "";
            const toolName =
              typeof record.toolName === "string" && record.toolName.length > 0
                ? record.toolName
                : type.replace(/^tool-/, "");
            const isError =
              state === "output-error" || state === "output-denied";
            const toolCallId =
              typeof record.toolCallId === "string" ? record.toolCallId : "";

            // Draft skill: render preview card with Accept/Discard
            if (
              toolName === "draft_skill" &&
              state === "output-available" &&
              typeof record.output === "string"
            ) {
              try {
                const draft = JSON.parse(record.output) as Record<
                  string,
                  unknown
                >;
                if (draft.type === "draftSkill") {
                  return (
                    <SkillDraftCard
                      key={`tool-${toolCallId || index}`}
                      draft={draft}
                      toolCallId={toolCallId}
                      onAccept={onAcceptSkill}
                      onDiscard={onDiscardSkill}
                      state={skillDraftState?.[toolCallId]}
                    />
                  );
                }
              } catch {
                // fall through to generic rendering
              }
            }

            // Test skill: render prompt badges
            if (
              toolName === "test_skill" &&
              state === "output-available" &&
              typeof record.output === "string"
            ) {
              try {
                const testResult = JSON.parse(record.output) as Record<
                  string,
                  unknown
                >;
                if (testResult.type === "testSkill") {
                  return (
                    <SkillTestResult
                      key={`tool-${toolCallId || index}`}
                      result={testResult}
                    />
                  );
                }
              } catch {
                // fall through to generic rendering
              }
            }

            return (
              <div
                key={`tool-${typeof record.toolCallId === "string" ? record.toolCallId : index}`}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
                  isError
                    ? "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400"
                    : state === "output-available"
                      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                      : "border-blue-500/30 bg-blue-500/5 text-muted-foreground"
                }`}
              >
                <Wrench className="size-3 shrink-0" />
                <span className="font-medium">{toolName}</span>
                <span className="ml-auto">
                  {isError
                    ? "error"
                    : state === "output-available"
                      ? "done"
                      : "running…"}
                </span>
              </div>
            );
          }

          // Reasoning and other non-visual parts stay collapsed for now.
          return null;
        })}
      </div>
    </div>
  );
}

/** Draft skill preview card with Accept/Discard buttons. */
function SkillDraftCard({
  draft,
  toolCallId,
  onAccept,
  onDiscard,
  state,
}: {
  draft: Record<string, unknown>;
  toolCallId: string;
  onAccept?: (
    toolCallId: string,
    draft: {
      name: string;
      description: string;
      content: string;
      skillPath: string;
    },
  ) => void;
  onDiscard?: (toolCallId: string) => void;
  state?: "busy" | "done" | "error" | "discarded";
}) {
  const valid = draft.valid === true;
  const name = typeof draft.name === "string" ? draft.name : "";
  const description =
    typeof draft.description === "string" ? draft.description : "";
  const content = typeof draft.content === "string" ? draft.content : "";
  const skillPath = typeof draft.skillPath === "string" ? draft.skillPath : "";
  const errors = Array.isArray(draft.errors) ? draft.errors : [];
  const detail = typeof draft.detail === "string" ? draft.detail : "";

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px]">
      <div className="mb-1.5 flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
        <FileText className="size-3 shrink-0" />
        <span>Draft Skill{valid ? `: ${name}` : ""}</span>
      </div>
      {valid ? (
        <>
          <p className="mb-1 text-muted-foreground">{description}</p>
          {skillPath && (
            <p className="mb-2 font-mono text-[10px] text-muted-foreground">
              {skillPath}
            </p>
          )}
          <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-background/50 p-1.5 font-mono text-[10px]">
            {content}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                onAccept?.(toolCallId, {
                  name: name,
                  description: description,
                  content: content,
                  skillPath: skillPath,
                })
              }
              disabled={
                state === "busy" || state === "done" || state === "discarded"
              }
              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {state === "busy" ? (
                <Loader2 className="size-2.5 animate-spin" />
              ) : (
                <Check className="size-2.5" />
              )}
              {state === "done" ? "Committed" : "Accept"}
            </button>
            <button
              type="button"
              onClick={() => onDiscard?.(toolCallId)}
              disabled={
                state === "busy" || state === "done" || state === "discarded"
              }
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <X className="size-2.5" />
              {state === "discarded" ? "Discarded" : "Discard"}
            </button>
            {state === "error" && (
              <span className="text-[10px] text-destructive">
                Commit failed — check your bearer token.
              </span>
            )}
          </div>
        </>
      ) : (
        <div className="space-y-0.5 text-destructive">
          {errors.map((err, i) => (
            <p key={i}>{String(err)}</p>
          ))}
          {detail && <p className="text-muted-foreground">{detail}</p>}
        </div>
      )}
    </div>
  );
}

/** Skill test result: prompt validation badges. */
function SkillTestResult({ result }: { result: Record<string, unknown> }) {
  const prompts = Array.isArray(result.prompts)
    ? (result.prompts as Array<Record<string, unknown>>)
    : [];
  const detail = typeof result.detail === "string" ? result.detail : "";

  return (
    <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-2.5 text-[11px]">
      <div className="mb-1.5 flex items-center gap-1.5 font-medium text-blue-700 dark:text-blue-400">
        <FileText className="size-3 shrink-0" />
        <span>
          Skill Test{result.valid === true ? " — Ready" : " — Failed"}
        </span>
      </div>
      {prompts.length > 0 && (
        <div className="mb-1.5 space-y-1">
          {prompts.map((p, i) => {
            const promptText = typeof p.prompt === "string" ? p.prompt : "";
            const status = typeof p.status === "string" ? p.status : "";
            const pError = typeof p.error === "string" ? p.error : "";

            return (
              <div
                key={i}
                className="flex items-start gap-1.5 rounded bg-background/50 px-1.5 py-1"
              >
                <span
                  className={`mt-0.5 size-1.5 shrink-0 rounded-full ${
                    status === "validated" ? "bg-emerald-500" : "bg-red-500"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {promptText}
                </span>
                {pError && (
                  <span className="shrink-0 text-destructive">{pError}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {detail && <p className="text-muted-foreground">{detail}</p>}
    </div>
  );
}
