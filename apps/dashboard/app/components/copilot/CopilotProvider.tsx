"use client";

import { useShortcutRegistry } from "@/app/components/ShortcutProvider";
import { useDashboardIndex } from "@/app/hooks/useDashboardIndex";
import { useStage } from "@/app/hooks/useStage";
import type { DockSession } from "@/app/lib/agentDock";
import {
  actionTier,
  type CopilotAction,
  type CopilotPlan,
} from "@/app/lib/copilotActions";
import { planFromQuery, type CopilotContext } from "@/app/lib/copilotIntent";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { navHref } from "@/app/lib/navigation";
import type { SearchItem } from "@/app/lib/paletteSearch";
import { STREAM_COMMIT_MS } from "@/app/lib/perfReport";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
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
  isOpen: boolean;
  /** Empty until `wakeIndex`. */
  items: readonly SearchItem[];
  messages: readonly CopilotMessage[];
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
  const { stageId } = useStage();
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
  const updateCron = useMutation(api.agent.cronsPublic.update);
  const setEnvVar = useMutation(api.environmentVariables.set);
  const mintSession = useMutation(api.agentDock.session);
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

  const run = useCallback(
    (action: CopilotAction): void => {
      switch (action.type) {
        case "navigate":
          router.push(action.href);

          return;
        case "openNode":
          if (!projectId) return;
          router.push(
            `${navHref(projectId, "", stageId)}${stageId ? "&" : "?"}node=${action.nodeId}`,
          );

          return;
        case "command":
          registry.trigger(action.commandId);

          return;
        case "setCronStatus":
          void updateCron({ cronId: action.cronId, status: action.status });

          return;
        case "setEnvVar":
          if (!projectId || !stageId) return;
          void setEnvVar({
            name: action.name,
            projectId: projectId,
            stageId: stageId,
            value: action.value,
          });

          return;
        case "blocked":
          return;
      }
    },
    [projectId, registry, router, setEnvVar, stageId, updateCron],
  );

  const runSafeSteps = useCallback(
    (messageId: string, plan: CopilotPlan): void => {
      const safe = plan.actions.flatMap((action, index) =>
        actionTier(action) === "safe" ? [index] : [],
      );
      for (const index of safe) run(plan.actions[index]);
      setCompleted((prev) => {
        const next = new Set(prev);
        for (const index of safe) next.add(`${messageId}:${index}`);

        return next;
      });
    },
    [run],
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
        const endpoint = resolveCoreEndpoint();
        if (!endpoint.ok) throw new Error(endpoint.message);
        // Lazy: zod and the stream reader load on the first ask, not with every page.
        const { dockPrompt, PROPOSE_TOOL, proposalPlan, streamDockAnswer } =
          await import("@/app/lib/agentDock");
        const stream = streamDockAnswer(
          session,
          endpoint.httpBaseUrl,
          conversationKey,
          dockPrompt(query, context),
        );
        for await (const part of stream) {
          if (part.type === "text-delta") text += part.text;
          else if (
            part.type === "tool-call" &&
            part.toolName === PROPOSE_TOOL
          ) {
            plan = proposalPlan(part.input, context) ?? plan;
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
    [conversationKey, runSafeSteps],
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
      run(action);
      setCompleted((prev) => new Set(prev).add(`${messageId}:${index}`));
    },
    [messages, run, scope],
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
      isOpen: isOpen,
      items: items,
      messages: shownMessages,
      runAction: run,
      runStep: runStep,
      setOpen: setOpen,
      wakeIndex: wakeIndex,
    }),
    [ask, completed, isOpen, items, run, runStep, setOpen, shownMessages],
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
