"use client";

/** Test tab with a streaming chat window for testing a deployed agent. */
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
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { useAgentChat } from "@/app/hooks/useAgentChat";
import {
  resolveChatError,
  type ChatErrorActionKind,
  type ChatErrorPresentation,
} from "@/app/lib/chatErrors";
import {
  relativeTime,
  uiMessagesFromStoredEvents,
  type StoredConversationEventRow,
} from "@/app/lib/conversationHistory";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { UIMessage } from "ai";
import { useConvex, useMutation, useQuery } from "convex/react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { memo, useCallback, useEffect, useRef, useState } from "react";
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
  agentId,
  nodeColor,
  onOpenDetails,
  agentConfigId,
}: {
  activeDeployment: StageDeployment | undefined;
  deploymentApiKey?: string;
  agentId: string;
  nodeColor?: string;
  /** Switches the side panel to the Details tab (error-card action). */
  onOpenDetails?: () => void;
  /** Enables persisted conversation history when present. */
  agentConfigId?: Id<"agentConfigs">;
}): React.JSX.Element {
  if (!activeDeployment) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          No runtime API key for this stage yet. Generate one in Details to test
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

  const chatProps = {
    endpointId: activeDeployment.endpointId,
    agentId: agentId,
    apiKey: deploymentApiKey,
    projectSlug: activeDeployment.projectSlug,
    nodeColor: nodeColor,
    stageSlug: activeDeployment.stageSlug,
    onOpenDetails: onOpenDetails,
  };

  return agentConfigId ? (
    <ConversationChat {...chatProps} agentConfigId={agentConfigId} />
  ) : (
    <ChatWindow {...chatProps} />
  );
}

/** How the chat is addressed: a fresh conversation or a persisted one. */
type ConversationSelection =
  | { kind: "new"; nonce: number }
  | { kind: "existing"; conversationKey: string };

/** Bound on transcript pages loaded per conversation (100 events each). */
const MAX_TRANSCRIPT_PAGES = 20;

/**
 * Chat with persisted history: a conversation picker over the runtime's
 * transcript store, hydrating `ChatWindow` (remounted per conversation via
 * `key`) with the stored messages so a conversation survives the panel
 * closing. See conversationsPublic.ts for the read side.
 */
function ConversationChat({
  agentConfigId,
  ...chatProps
}: {
  endpointId: string;
  agentId: string;
  apiKey: string;
  projectSlug?: string;
  nodeColor?: string;
  stageSlug?: string;
  onOpenDetails?: () => void;
  agentConfigId: Id<"agentConfigs">;
}) {
  const convex = useConvex();
  const history = useQuery(api.conversationsPublic.listForAgent, {
    configId: agentConfigId,
  });
  const [selection, setSelection] = useState<ConversationSelection | null>(
    null,
  );
  // Pick the most recent conversation once per agent, when history first
  // loads. Done during render, guarded by the synced id (repo pattern).
  const [syncedConfigId, setSyncedConfigId] =
    useState<Id<"agentConfigs"> | null>(null);
  if (history !== undefined && syncedConfigId !== agentConfigId) {
    setSyncedConfigId(agentConfigId);
    const latest = history.conversations[0];
    setSelection(
      latest
        ? { kind: "existing", conversationKey: latest.conversationKey }
        : { kind: "new", nonce: 0 },
    );
  }

  // Load the selected conversation's transcript (paged, oldest first).
  const [transcript, setTranscript] = useState<{
    conversationKey: string;
    messages: UIMessage[];
  } | null>(null);
  useEffect(() => {
    if (selection?.kind !== "existing") return;
    const conversationKey = selection.conversationKey;
    let cancelled = false;
    void (async () => {
      const rows: StoredConversationEventRow[] = [];
      let afterCursor: string | undefined;
      for (let pageIndex = 0; pageIndex < MAX_TRANSCRIPT_PAGES; pageIndex++) {
        const result = await convex.query(
          api.conversationsPublic.listMessages,
          {
            configId: agentConfigId,
            conversationKey: conversationKey,
            afterCursor: afterCursor,
          },
        );
        rows.push(...result.page);
        if (result.isDone || !result.continueCursor) break;
        afterCursor = result.continueCursor;
      }
      if (!cancelled) {
        setTranscript({
          conversationKey: conversationKey,
          messages: uiMessagesFromStoredEvents(rows),
        });
      }
    })().catch((error: unknown) => {
      if (!cancelled) {
        console.warn("[agent-chat] failed to load conversation:", error);
        setTranscript({ conversationKey: conversationKey, messages: [] });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [agentConfigId, convex, selection]);

  const startNewConversation = useCallback(() => {
    setSelection((previous) => ({
      kind: "new",
      nonce: previous?.kind === "new" ? previous.nonce + 1 : 0,
    }));
  }, []);

  const conversations = history?.conversations ?? [];
  const currentTitle =
    selection?.kind === "existing"
      ? (conversations.find(
          (entry) => entry.conversationKey === selection.conversationKey,
        )?.title ?? "Conversation")
      : "New conversation";

  const transcriptReady =
    selection?.kind === "existing" &&
    transcript?.conversationKey === selection.conversationKey;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ConversationListHeader
        agentConfigId={agentConfigId}
        conversations={conversations}
        currentTitle={currentTitle}
        selectedKey={
          selection?.kind === "existing" ? selection.conversationKey : null
        }
        onSelect={(conversationKey) =>
          setSelection({ kind: "existing", conversationKey: conversationKey })
        }
        onNewConversation={startNewConversation}
        onDeletedSelected={startNewConversation}
      />
      {selection === null ||
      (selection.kind === "existing" && !transcriptReady) ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : selection.kind === "new" ? (
        <ChatWindow key={`new-${selection.nonce}`} {...chatProps} />
      ) : (
        <ChatWindow
          key={selection.conversationKey}
          {...chatProps}
          initialMessages={transcript?.messages}
          initialSessionId={selection.conversationKey}
          onNewChat={startNewConversation}
        />
      )}
    </div>
  );
}

/** Rename field, focused on mount (opens only from an explicit user click). */
function RenameInput({
  value,
  onChange,
  onKeyDown,
  className,
}: {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      className={className}
    />
  );
}

/** One row of the conversation picker, as served by `listForAgent`. */
interface ConversationRow {
  conversationKey: string;
  title: string;
  createdAt: number;
  lastMessageAt: number;
}

/**
 * Header bar naming the open conversation, with a collapsible picker holding
 * per-conversation rename (inline) and delete (two-step confirm).
 */
function ConversationListHeader({
  agentConfigId,
  conversations,
  currentTitle,
  selectedKey,
  onSelect,
  onNewConversation,
  onDeletedSelected,
}: {
  agentConfigId: Id<"agentConfigs">;
  conversations: ConversationRow[];
  currentTitle: string;
  selectedKey: string | null;
  onSelect: (conversationKey: string) => void;
  onNewConversation: () => void;
  onDeletedSelected: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const renameConversation = useMutation(
    api.conversationsPublic.renameConversation,
  );
  const deleteConversation = useMutation(
    api.conversationsPublic.deleteConversation,
  );

  async function submitRename(conversationKey: string) {
    const title = renameDraft.trim();
    setRenamingKey(null);
    if (!title) return;
    await renameConversation({
      configId: agentConfigId,
      conversationKey: conversationKey,
      title: title,
    });
  }

  async function submitDelete(conversationKey: string) {
    setConfirmDeleteKey(null);
    // Batched server-side; loop until the conversation is fully gone.
    for (;;) {
      const result = await deleteConversation({
        configId: agentConfigId,
        conversationKey: conversationKey,
      });
      if (!result.hasMore) break;
    }
    if (conversationKey === selectedKey) {
      onDeletedSelected();
    }
  }

  return (
    <div className="shrink-0 border-b">
      <div className="flex items-center gap-1 px-3 py-1.5">
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-foreground hover:bg-muted/50 transition-colors"
          onClick={() => setOpen((previous) => !previous)}
          title="Conversation history"
        >
          <History className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{currentTitle}</span>
          <ChevronDown
            className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-2 text-xs"
          onClick={onNewConversation}
          title="New conversation"
        >
          <Plus className="size-3" />
          New
        </Button>
      </div>
      {open && (
        <div className="max-h-56 overflow-y-auto border-t px-1.5 py-1.5">
          {conversations.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No conversations yet.
            </p>
          )}
          {conversations.map((conversation) => (
            <div
              key={conversation.conversationKey}
              className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/50 ${
                conversation.conversationKey === selectedKey
                  ? "bg-muted/60"
                  : ""
              }`}
            >
              {renamingKey === conversation.conversationKey ? (
                <>
                  <RenameInput
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void submitRename(conversation.conversationKey);
                      }
                      if (event.key === "Escape") setRenamingKey(null);
                    }}
                    className="h-6 flex-1 text-xs"
                  />
                  <button
                    type="button"
                    className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      void submitRename(conversation.conversationKey)
                    }
                    title="Save name"
                  >
                    <Check className="size-3" />
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => setRenamingKey(null)}
                    title="Cancel"
                  >
                    <X className="size-3" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                    onClick={() => {
                      onSelect(conversation.conversationKey);
                      setOpen(false);
                    }}
                  >
                    <span className="truncate text-foreground">
                      {conversation.title}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {relativeTime(conversation.lastMessageAt)}
                    </span>
                  </button>
                  {confirmDeleteKey === conversation.conversationKey ? (
                    <>
                      <button
                        type="button"
                        className="cursor-pointer rounded px-1 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
                        onClick={() =>
                          void submitDelete(conversation.conversationKey)
                        }
                      >
                        Delete?
                      </button>
                      <button
                        type="button"
                        className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
                        onClick={() => setConfirmDeleteKey(null)}
                        title="Cancel"
                      >
                        <X className="size-3" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                        onClick={() => {
                          setRenamingKey(conversation.conversationKey);
                          setRenameDraft(conversation.title);
                        }}
                        title="Rename"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        className="cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                        onClick={() =>
                          setConfirmDeleteKey(conversation.conversationKey)
                        }
                        title="Delete"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Chat window that streams messages from the core service. */
function ChatWindow({
  endpointId,
  agentId,
  apiKey,
  projectSlug,
  nodeColor,
  stageSlug,
  onOpenDetails,
  initialMessages,
  initialSessionId,
  onNewChat,
}: {
  endpointId: string;
  agentId: string;
  apiKey: string;
  projectSlug?: string;
  nodeColor?: string;
  stageSlug?: string;
  onOpenDetails?: () => void;
  /** Persisted transcript to hydrate with (remount via `key` to switch). */
  initialMessages?: UIMessage[];
  /** Conversation key the next send continues. */
  initialSessionId?: string;
  /** Overrides the composer's reset control when history drives the chat. */
  onNewChat?: () => void;
}) {
  const { messages, status, error, sendMessage, resetChat } = useAgentChat({
    endpointId: endpointId,
    agentId: agentId,
    apiKey: apiKey,
    projectSlug: projectSlug,
    stageSlug: stageSlug,
    webSocketEnabled: true,
    initialMessages: initialMessages,
    initialSessionId: initialSessionId,
  });
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasAssistantMessage = messages.some((m) => m.role === "assistant");
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();

  const handleErrorAction = useCallback(
    (kind: ChatErrorActionKind) => {
      if (kind === "open-details") {
        onOpenDetails?.();

        return;
      }
      if (kind === "open-env-vars") {
        // Same href shape the settings page builds: keep the current params
        // (e.g. ?stage=) so the variables shown match the stage being tested.
        const next = new URLSearchParams(searchParams.toString());
        next.set("tab", "variables");
        router.push(`/${params.projectId}/settings?${next.toString()}`);

        return;
      }
      if (kind === "retry") {
        const lastUserText = [...messages]
          .reverse()
          .find((m) => m.role === "user")
          ?.parts.filter((p) => p.type === "text")
          .map((p) => ("text" in p ? p.text : ""))
          .join("");
        if (lastUserText) {
          void sendMessage(lastUserText);
        }
      }
    },
    [
      messages,
      onOpenDetails,
      params.projectId,
      router,
      searchParams,
      sendMessage,
    ],
  );

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
          <MessageBubble
            key={msg.id || i}
            message={msg}
            nodeColor={nodeColor}
          />
        ))}
        {status === "streaming" && !hasAssistantMessage && (
          <ThinkingIndicator nodeColor={nodeColor} />
        )}
        {error && (
          <ChatErrorCard
            presentation={resolveChatError(error.message)}
            onAction={handleErrorAction}
          />
        )}
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
                onClick={onNewChat ?? resetChat}
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

/**
 * Error card rendered in the transcript where a send failed: one plain
 * sentence, at most one action, and the raw payload behind a disclosure.
 */
function ChatErrorCard({
  presentation,
  onAction,
}: {
  presentation: ChatErrorPresentation;
  onAction: (kind: ChatErrorActionKind) => void;
}) {
  const { title, detail, action, raw } = presentation;

  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail && (
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      )}
      {action && action.kind !== "none" && (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 h-7 text-xs"
          onClick={() => onAction(action.kind)}
        >
          {action.label}
        </Button>
      )}
      <Collapsible>
        <CollapsibleTrigger className="group mt-2 flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <ChevronRight className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90" />
          Show details
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-1 max-h-40 max-w-full overflow-y-auto overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-md border border-red-500/20 bg-red-500/5 px-2.5 py-2 font-mono text-xs text-muted-foreground">
            {raw}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** Colored circle avatar matching the agent node on the canvas. */
function AgentAvatar({
  color,
  className,
  label,
}: {
  color?: string;
  className?: string;
  label?: string;
}) {
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
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

/** Renders a single chat message with reasoning, tool, and text parts in order. */
const MessageBubble = memo(function MessageBubble({
  message,
  nodeColor,
}: {
  message: UIMessage;
  nodeColor?: string;
}) {
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

  // Render all parts in order for assistant messages
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
          if (
            type === "dynamic-tool" ||
            (type.startsWith("tool-") && type !== "text")
          ) {
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
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/5 px-2 py-1.5 text-xs hover:bg-cyan-500/10 transition-colors">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90" />
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
        <div
          ref={contentRef}
          className="ml-5 mt-1 max-h-40 space-y-2 overflow-y-auto overflow-x-auto rounded-md border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-2"
        >
          {events.length > 0 && (
            <div className="flex flex-col gap-1">
              {events.map((event, index) => (
                <p
                  key={`subagent-event-${index}`}
                  className="text-[11px] text-cyan-700 wrap-break-word dark:text-cyan-200/90"
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

/** Collapsible block showing the model's reasoning/thinking process. */
function ReasoningBlock({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
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
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 transition-colors">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90" />
        <span className="font-medium">
          {isStreaming ? "Thinking..." : "Thinking"}
        </span>
        <span className="ml-auto tabular-nums">{formatElapsed(elapsed)}</span>
        {isStreaming && <Loader2 className="size-3 animate-spin" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 mt-1 rounded-md border border-purple-500/20 bg-purple-500/5 px-2.5 py-2">
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
        className={`group flex w-full cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors ${
          isError
            ? "border-red-500/30 bg-red-500/5 hover:bg-red-500/10"
            : hasOutput
              ? "border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10"
              : "border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10"
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
        {isRunning && (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 mt-1 flex flex-col gap-1.5">
          {/* Tool call request */}
          <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-2.5 py-2">
            <p className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-blue-700 dark:text-blue-400">
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
                  isError
                    ? "text-red-700 dark:text-red-400"
                    : "text-emerald-700 dark:text-emerald-400"
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
          <span className="animate-pulse [animation-delay:0ms]">.</span>
          <span className="animate-pulse [animation-delay:150ms]">.</span>
          <span className="animate-pulse [animation-delay:300ms]">.</span>
        </span>
      </div>
    </div>
  );
}
