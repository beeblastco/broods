"use client";

/**
 * The copilot's state and its hands. Held above the router so the conversation
 * survives navigation, which is the whole point of a dock over a dialog: the
 * copilot moves you to another page and the thread is still there when you land.
 */
import { useShortcutRegistry } from "@/app/components/ShortcutProvider";
import { useDashboardIndex } from "@/app/hooks/useDashboardIndex";
import { useStage } from "@/app/hooks/useStage";
import {
  actionTier,
  planRunsUnattended,
  type CopilotAction,
  type CopilotPlan,
} from "@/app/lib/copilotActions";
import { planFromQuery } from "@/app/lib/copilotIntent";
import { navHref } from "@/app/lib/navigation";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useParams, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/** What the copilot says when an ask lands outside the rules it can resolve on its own. */
const NO_MODEL_REPLY =
  'I can only run what I can resolve from this project right now. Try a name, "go to <section>", "pause <cron>", "add an agent", or "set KEY to value".';

export interface CopilotMessage {
  id: string;
  plan?: CopilotPlan;
  role: "user" | "broods";
  text: string;
}

export interface CopilotState {
  ask: (query: string) => void;
  /** Keys of plan steps already run, as `${messageId}:${index}`. */
  completed: ReadonlySet<string>;
  isOpen: boolean;
  messages: readonly CopilotMessage[];
  /** Carry out one action. The palette selects rows through this. */
  runAction: (action: CopilotAction) => void;
  runStep: (messageId: string, index: number, action: CopilotAction) => void;
  setOpen: (open: boolean) => void;
}

const CopilotContext = createContext<CopilotState | null>(null);

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

  const items = useDashboardIndex(projectId, stageId);
  const crons = useQuery(
    api.agent.crons.listForProject,
    projectId ? { projectId: projectId } : "skip",
  );
  const envVars = useQuery(
    api.environmentVariables.list,
    projectId && stageId ? { projectId: projectId, stageId: stageId } : "skip",
  );
  const updateCron = useMutation(api.agent.cronsPublic.update);
  const setEnvVar = useMutation(api.environmentVariables.set);

  const [isOpen, setOpen] = useState(false);
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
          // `?node=` is how the canvas is told what to select, so a node opens
          // the same way from the palette, the copilot and a pasted link.
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

  const ask = useCallback(
    (query: string): void => {
      const trimmed = query.trim();
      if (!trimmed) return;

      const askedAt = String(Date.now());
      const plan = planFromQuery(trimmed, {
        crons: (crons ?? []).map((cron) => ({
          id: cron._id,
          name: cron.name,
          status: cron.status,
        })),
        envNames: (envVars ?? []).map((envVar) => envVar.name),
        items: items,
        liveCommands: registry.activeIds,
      });

      // Moving you around is not worth a button, so a plan that only navigates
      // runs on the spot and reports what it did.
      const unattended = plan !== null && planRunsUnattended(plan);
      if (unattended) {
        for (const action of plan.actions) run(action);
      }

      setMessages((prev) => [
        ...prev,
        { id: `${askedAt}:you`, role: "user", text: trimmed },
        {
          id: `${askedAt}:broods`,
          plan: plan ?? undefined,
          role: "broods",
          text: plan?.summary ?? NO_MODEL_REPLY,
        },
      ]);
      if (unattended) {
        setCompleted((prev) => {
          const next = new Set(prev);
          plan.actions.forEach((_, index) =>
            next.add(`${askedAt}:broods:${index}`),
          );

          return next;
        });
      }
    },
    [crons, envVars, items, registry.activeIds, run],
  );

  const runStep = useCallback(
    (messageId: string, index: number, action: CopilotAction): void => {
      if (actionTier(action) === "blocked") return;
      run(action);
      setCompleted((prev) => new Set(prev).add(`${messageId}:${index}`));
    },
    [run],
  );

  const value = useMemo(
    () => ({
      ask: ask,
      completed: completed,
      isOpen: isOpen,
      messages: messages,
      runAction: run,
      runStep: runStep,
      setOpen: setOpen,
    }),
    [ask, completed, isOpen, messages, run, runStep],
  );

  return <CopilotStateProvider value={value}>{children}</CopilotStateProvider>;
}

/**
 * The context on its own, for a tree that builds the state itself. The
 * `/ui-gallery` fixture uses it to drive the dock with no Convex or router.
 */
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
