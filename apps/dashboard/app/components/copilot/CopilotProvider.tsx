"use client";

import { useShortcutRegistry } from "@/app/components/ShortcutProvider";
import { isCodeManagedOwner } from "@/app/components/canvas/edgeOwnership";
import { useDashboardIndex } from "@/app/hooks/useDashboardIndex";
import { useStage } from "@/app/hooks/useStage";
import type { DockFacts, DockSession } from "@/app/lib/agentDock";
import {
  actionTier,
  pendingChanges,
  type CopilotAction,
  type CopilotPlan,
  type PendingChange,
} from "@/app/lib/copilotActions";
import { planFromQuery, type CopilotContext } from "@/app/lib/copilotIntent";
import { navHref } from "@/app/lib/navigation";
import { requestCanvasAction } from "@/app/lib/canvasActions";
import { toErrorMessage } from "@/app/lib/errors";
import type { SearchItem } from "@/app/lib/paletteSearch";
import { STREAM_COMMIT_MS } from "@/app/lib/perfReport";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { useParams, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

const NO_MODEL_REPLY =
  'I can only run what I can resolve from this project right now. Try a name, "go to <section>", "pause <cron>", "add an agent", or "set KEY to value".';

// A session minted this close to expiry is renewed before the next ask.
const SESSION_RENEW_MS = 60 * 1000;

export interface CopilotMessage {
  id: string;
  /** Set while the Broods agent has not answered yet. */
  pending?: boolean;
  plan?: CopilotPlan;
  role: "user" | "broods";
  /** The project and stage it was asked on; its writes refuse to run anywhere else. */
  scope?: string;
  stale?: boolean;
  text: string;
}

export interface CopilotState {
  ask: (query: string) => void;
  /** Keys of plan steps already run, as `${messageId}:${index}`. */
  completed: ReadonlySet<string>;
  /** Keys of plan steps the user discarded, in the same form. */
  dismissed: ReadonlySet<string>;
  dismissStep: (messageId: string, index: number) => void;
  isOpen: boolean;
  /** Empty until `wakeIndex`. */
  items: readonly SearchItem[];
  messages: readonly CopilotMessage[];
  /** Writes still waiting for Apply, from answers asked on this project and stage. */
  pending: readonly PendingChange[];
  runAction: (action: CopilotAction) => void;
  runStep: (messageId: string, index: number, action: CopilotAction) => void;
  setOpen: (open: boolean) => void;
  wakeIndex: () => void;
}

const CopilotContext = createContext<CopilotState | null>(null);

// Mounted above the router, so the thread survives the navigation the copilot does.
export function CopilotProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const params = useParams<{ projectId?: string }>();
  const projectId = (params.projectId ?? null) as Id<"projects"> | null;
  const { stageArgs, stageId } = useStage();
  const router = useRouter();
  const registry = useShortcutRegistry();

  // Most visits open neither the palette nor the dock, so the index subscribes once wanted.
  const [indexAwake, wakeIndex] = useReducer(() => true, false);
  const indexedProject = indexAwake ? projectId : null;

  const items = useDashboardIndex(indexedProject);
  const crons = useQuery(
    api.agent.crons.listForProject,
    indexedProject ? { projectId: indexedProject } : "skip",
  );
  const envVars = useQuery(
    api.environmentVariables.list,
    indexedProject && stageId
      ? { projectId: indexedProject, stageId: stageId }
      : "skip",
  );
  // The same arguments as the index, so these share its subscriptions.
  const canvas = useQuery(
    api.canvas.getByProject,
    indexedProject ? stageArgs : "skip",
  );
  const projects = useQuery(api.project.list, indexedProject ? {} : "skip");
  const stages = useQuery(
    api.stage.list,
    indexedProject ? { projectId: indexedProject } : "skip",
  );
  const facts = useMemo((): DockFacts => {
    const labels = new Map(
      (canvas?.nodes ?? []).map((node) => [
        node.id,
        typeof node.data.label === "string" ? node.data.label : node.id,
      ]),
    );
    const repo = projects?.find((project) => project._id === projectId)?.repo;
    const branches = [
      repo?.productionBranch && `Production from ${repo.productionBranch}`,
      repo?.developmentBranch && `Development from ${repo.developmentBranch}`,
    ].filter(Boolean);

    return {
      codeNodes: (canvas?.nodes ?? [])
        .filter((node) => isCodeManagedOwner(node.data.managedBy))
        .map((node) => labels.get(node.id) ?? node.id),
      connections: (canvas?.edges ?? []).map(
        (edge) =>
          `${labels.get(edge.source) ?? edge.source} → ${labels.get(edge.target) ?? edge.target}`,
      ),
      project: projects?.find((project) => project._id === projectId)?.name,
      repo: repo ? `${repo.fullName} (${branches.join(", ")})` : undefined,
      stage: stages?.find((stage) =>
        stageId ? stage._id === stageId : stage.isDefault,
      )?.name,
    };
  }, [canvas, projectId, projects, stageId, stages]);
  const updateCron = useMutation(api.agent.cronsPublic.update);
  const setEnvVar = useMutation(api.environmentVariables.set);
  const mintSession = useMutation(api.agentDock.session);
  const commitChange = useAction(api.agentDock.commitChange);
  const readRepo = useAction(api.agentDock.repoFiles);
  const currentStageId =
    stageId ?? stages?.find((stage) => stage.isDefault)?._id ?? null;
  const sessionRef = useRef<DockSession | null | undefined>(undefined);
  const [conversationKey] = useState(() => `dock-${crypto.randomUUID()}`);

  const scope = `${projectId ?? ""}:${stageId ?? ""}`;
  const [isOpen, setIsOpen] = useState(false);
  const setOpen = useCallback((open: boolean): void => {
    if (open) wakeIndex();
    setIsOpen(open);
  }, []);
  const [messages, setMessages] = useState<readonly CopilotMessage[]>([]);
  const [completed, setCompleted] = useState<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  const note = useCallback((text: string): void => {
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}:note`, role: "broods", text: text },
    ]);
  }, []);

  // Answers whether the step took effect; a refusal is noted in the thread and the step stays open.
  const perform = useCallback(
    async (action: CopilotAction): Promise<boolean> => {
      try {
        switch (action.type) {
          case "navigate":
            router.push(action.href);

            return true;
          case "openNode":
            if (!projectId) return false;
            router.push(
              `${navHref(projectId, "", stageId)}${stageId ? "&" : "?"}node=${action.nodeId}`,
            );

            return true;
          case "command":
            if (!registry.activeIds.has(action.commandId)) {
              note("Open the Architecture canvas first.");

              return false;
            }
            registry.trigger(action.commandId);

            return true;
          case "setCronStatus":
            await updateCron({ cronId: action.cronId, status: action.status });

            return true;
          case "setEnvVar":
            if (!projectId || !stageId) return false;
            await setEnvVar({
              name: action.name,
              projectId: projectId,
              stageId: stageId,
              value: action.value,
            });

            return true;
          case "blocked":
            return false;
          case "connectNodes":
            await requestCanvasAction({
              kind: "connect",
              source: action.source,
              target: action.target,
            });

            return true;
          case "addMcp":
            await requestCanvasAction({
              ...(action.agent ? { agent: action.agent } : {}),
              kind: "addMcp",
              name: action.name,
              url: action.url,
            });

            return true;
          case "commitFiles": {
            if (!projectId || !currentStageId) return false;
            const result = await commitChange({
              baseSha: action.baseSha,
              branch: action.branch,
              files: [...action.files],
              message: action.message,
              projectId: projectId,
              stageId: currentStageId,
            });
            note(
              result.viaPullRequest
                ? `Opened a pull request: ${result.url}`
                : `Committed: ${result.url}. The stage deploys in about a minute.`,
            );

            return true;
          }
        }
      } catch (error) {
        note(toErrorMessage(error));

        return false;
      }
    },
    [
      commitChange,
      currentStageId,
      note,
      projectId,
      registry,
      router,
      setEnvVar,
      stageId,
      updateCron,
    ],
  );

  const settle = useCallback(
    async (messageId: string, index: number, action: CopilotAction) => {
      if (await perform(action)) {
        setCompleted((prev) => new Set(prev).add(`${messageId}:${index}`));
      }
    },
    [perform],
  );

  const runSafeSteps = useCallback(
    (messageId: string, plan: CopilotPlan): void => {
      plan.actions.forEach((action, index) => {
        if (actionTier(action) === "safe")
          void settle(messageId, index, action);
      });
    },
    [settle],
  );

  const dockSession = useCallback(async (): Promise<DockSession | null> => {
    const cached = sessionRef.current;
    if (
      cached === null ||
      (cached && cached.expiresAt - SESSION_RENEW_MS > Date.now())
    ) {
      return cached;
    }
    try {
      sessionRef.current = await mintSession({});
    } catch {
      return null;
    }

    return sessionRef.current;
  }, [mintSession]);

  const askAgent = useCallback(
    async (
      replyId: string,
      query: string,
      context: CopilotContext,
      session: DockSession,
    ): Promise<void> => {
      const update = (patch: Partial<CopilotMessage>): void =>
        setMessages((prev) =>
          prev.map((message) =>
            message.id === replyId ? { ...message, ...patch } : message,
          ),
        );
      let text = "";
      let plan: CopilotPlan | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Lazy: zod and the stream reader load on the first ask, not with every page.
        const {
          ASK_TOOL,
          dockPrompt,
          PROPOSE_TOOL,
          proposalPlan,
          questionText,
          streamDockAnswer,
        } = await import("@/app/lib/agentDock");
        // A linked repo's broods/ folder is what the agent edits; without it, it only advises.
        const repo =
          facts.repo && projectId && currentStageId
            ? await readRepo({
                projectId: projectId,
                stageId: currentStageId,
              }).catch((error: unknown) => {
                note(`Could not read ${facts.repo}: ${toErrorMessage(error)}`);

                return null;
              })
            : null;
        const stream = streamDockAnswer(
          session,
          conversationKey,
          dockPrompt(query, context, facts, repo ?? undefined),
        );
        // Text after a tool call is the next model step: keep it a paragraph apart.
        let afterTool = false;
        for await (const part of stream) {
          if (part.type === "text-delta") {
            text += afterTool && text ? `\n\n${part.text}` : part.text;
            afterTool = false;
          } else if (part.type === "tool-call") {
            afterTool = true;
            if (part.toolName === PROPOSE_TOOL) {
              plan =
                proposalPlan(part.input, context, repo ?? undefined) ?? plan;
            } else if (part.toolName === ASK_TOOL) {
              text += `${text ? "\n\n" : ""}${questionText(part.input)}`;
            } else continue;
          } else continue;
          timer ??= setTimeout(() => {
            timer = undefined;
            update({ plan: plan, text: text });
          }, STREAM_COMMIT_MS);
        }
        clearTimeout(timer);
        update({
          pending: false,
          plan: plan,
          text: text || plan?.summary || "",
        });
        if (plan) runSafeSteps(replyId, plan);
      } catch (error) {
        clearTimeout(timer);
        update({
          pending: false,
          text: `The Broods agent could not answer: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [
      conversationKey,
      currentStageId,
      facts,
      note,
      projectId,
      readRepo,
      runSafeSteps,
    ],
  );

  const ask = useCallback(
    (query: string): void => {
      const trimmed = query.trim();
      if (!trimmed) return;

      const askedAt = String(Date.now());
      const replyId = `${askedAt}:broods`;
      const context: CopilotContext = {
        crons: (crons ?? []).map((cron) => ({
          id: cron._id,
          name: cron.name,
          status: cron.status,
        })),
        envNames: (envVars ?? []).map((envVar) => envVar.name),
        items: items,
        liveCommands: registry.activeIds,
        lockedNodes: new Set(facts.codeNodes),
      };
      setMessages((prev) => [
        ...prev,
        { id: `${askedAt}:you`, role: "user", text: trimmed },
        {
          id: replyId,
          pending: true,
          role: "broods",
          scope: scope,
          text: "",
        },
      ]);

      void dockSession().then(async (session) => {
        if (session) return await askAgent(replyId, trimmed, context, session);

        const plan = planFromQuery(trimmed, context);
        setMessages((prev) =>
          prev.map((message) =>
            message.id === replyId
              ? {
                  ...message,
                  pending: false,
                  plan: plan ?? undefined,
                  text: plan?.summary ?? NO_MODEL_REPLY,
                }
              : message,
          ),
        );
        if (plan) runSafeSteps(replyId, plan);
      });
    },
    [
      askAgent,
      crons,
      dockSession,
      envVars,
      facts.codeNodes,
      items,
      runSafeSteps,
      registry.activeIds,
      scope,
    ],
  );

  const runStep = useCallback(
    (messageId: string, index: number, action: CopilotAction): void => {
      if (actionTier(action) === "blocked") return;
      const asked = messages.find((message) => message.id === messageId);
      if (asked?.scope !== undefined && asked.scope !== scope) return;
      void settle(messageId, index, action);
    },
    [messages, scope, settle],
  );

  const runAction = useCallback(
    (action: CopilotAction): void => {
      void perform(action);
    },
    [perform],
  );

  const dismissStep = useCallback((messageId: string, index: number): void => {
    setDismissed((prev) => new Set(prev).add(`${messageId}:${index}`));
  }, []);

  const pending = useMemo(
    () =>
      pendingChanges(
        messages.filter(
          (message) => message.scope === undefined || message.scope === scope,
        ),
        new Set([...completed, ...dismissed]),
      ),
    [completed, dismissed, messages, scope],
  );

  const shownMessages = useMemo(
    () =>
      messages.map((message) =>
        message.scope !== undefined && message.scope !== scope
          ? { ...message, stale: true }
          : message,
      ),
    [messages, scope],
  );

  const value = useMemo(
    () => ({
      ask: ask,
      completed: completed,
      dismissed: dismissed,
      dismissStep: dismissStep,
      isOpen: isOpen,
      items: items,
      messages: shownMessages,
      pending: pending,
      runAction: runAction,
      runStep: runStep,
      setOpen: setOpen,
      wakeIndex: wakeIndex,
    }),
    [
      ask,
      completed,
      dismissed,
      dismissStep,
      isOpen,
      items,
      pending,
      runAction,
      runStep,
      setOpen,
      shownMessages,
    ],
  );

  return <CopilotStateProvider value={value}>{children}</CopilotStateProvider>;
}

/** Lets the `/ui-gallery` fixture drive the dock with no Convex or router. */
export function CopilotStateProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: CopilotState;
}): React.JSX.Element {
  return (
    <CopilotContext.Provider value={value}>{children}</CopilotContext.Provider>
  );
}

export function useCopilot(): CopilotState {
  const state = useContext(CopilotContext);
  if (!state) throw new Error("useCopilot must be used inside CopilotProvider");

  return state;
}
