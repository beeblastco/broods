"use client";

import { useShortcutRegistry } from "@/app/components/ShortcutProvider";
import { isCodeManagedOwner } from "@/app/components/canvas/edgeOwnership";
import { useDashboardIndex } from "@/app/hooks/useDashboardIndex";
import { useStage } from "@/app/hooks/useStage";
import type { DockFacts, DockSession } from "@/app/lib/agentDock";
import {
  actionTier,
  changeKey,
  dockProposals,
  openProposal,
  proposedNodes,
  settleApplies,
  type CopilotAction,
  type CopilotPlan,
  type DockApply,
  type DockProposal,
  type ProposedNode,
  type TrackedDeploy,
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
  applyProposal: (messageId: string) => void;
  ask: (query: string) => void;
  /** Keys of plan steps already run, as `${messageId}:${index}`. */
  completed: ReadonlySet<string>;
  discardProposal: (messageId: string) => void;
  /** Leaves one step, or one file of its commit, out of the proposal. */
  dropChange: (messageId: string, index: number, path?: string) => void;
  isOpen: boolean;
  /** Empty until `wakeIndex`. */
  items: readonly SearchItem[];
  messages: readonly CopilotMessage[];
  /** The newest proposal still open on this project and stage: the bar and the canvas draw it. */
  proposal: DockProposal | null;
  /** Every answer's proposal by message id: the chat line reads it. */
  proposals: ReadonlyMap<string, DockProposal>;
  runAction: (action: CopilotAction) => void;
  setOpen: (open: boolean) => void;
  wakeIndex: () => void;
}

interface ProposedNodes {
  failed: boolean;
  nodes: readonly ProposedNode[];
}

const CopilotContext = createContext<CopilotState | null>(null);
const ProposedNodesContext = createContext<ProposedNodes>({
  failed: false,
  nodes: [],
});

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
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [applies, setApplies] = useState<Readonly<Record<string, DockApply>>>(
    {},
  );
  const [commits, setCommits] = useState<
    readonly Omit<TrackedDeploy, "runUrl" | "state">[]
  >([]);
  // Subscribed only while a commit deploys; the GitHub webhook moves its run along.
  const following = Object.values(applies).some(
    (apply) => apply.phase === "applying" && apply.sha !== undefined,
  );
  const github = useQuery(
    api.github.status,
    projectId && following ? { projectId: projectId } : "skip",
  );
  const deploys = useMemo(
    () =>
      commits.map((commit): TrackedDeploy => {
        const run = github?.deploys.find(
          (deploy) => deploy.branch === commit.branch,
        );
        // A newer run on the branch carries this commit too.
        if (
          !run ||
          (run.sha !== commit.sha && run.updatedAt < commit.committedAt)
        ) {
          return { ...commit, state: "waiting" };
        }
        if (run.status !== "completed") {
          return { ...commit, runUrl: run.url, state: "deploying" };
        }

        return {
          ...commit,
          conclusion: run.conclusion,
          finishedAt: run.updatedAt,
          runUrl: run.url,
          state: run.conclusion === "success" ? "deployed" : "failed",
        };
      }),
    [commits, github],
  );

  // Adjusted during render: a finished run is kept, so a later push cannot reopen it.
  const settled = settleApplies(applies, deploys);
  if (settled) setApplies(settled);

  const note = useCallback((text: string): void => {
    setMessages((prev) => [
      ...prev,
      { id: `${crypto.randomUUID()}:note`, role: "broods", text: text },
    ]);
  }, []);

  // Answers whether the step took effect; throws the reason a write was refused.
  const perform = useCallback(
    async (action: CopilotAction): Promise<boolean> => {
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
        case "addNode":
          await requestCanvasAction({
            agent: action.agent,
            kind: "addNode",
            nodeType: action.nodeType,
          });

          return true;
        case "commitFiles":
          return false;
      }
    },
    [note, projectId, registry, router, setEnvVar, stageId, updateCron],
  );

  // A refusal of a step that runs on its own is noted in the thread.
  const performNoted = useCallback(
    async (action: CopilotAction): Promise<boolean> => {
      try {
        return await perform(action);
      } catch (error) {
        note(toErrorMessage(error));

        return false;
      }
    },
    [note, perform],
  );

  const runSafeSteps = useCallback(
    (messageId: string, plan: CopilotPlan): void => {
      plan.actions.forEach((action, index) => {
        if (actionTier(action) !== "safe") return;
        void performNoted(action).then((done) => {
          if (done) {
            setCompleted((prev) =>
              new Set(prev).add(changeKey(messageId, index)),
            );
          }
        });
      });
    },
    [performNoted],
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

  const proposals = useMemo(
    () =>
      dockProposals(
        messages,
        dropped,
        completed,
        applies,
        deploys,
        facts.stage,
      ),
    [applies, completed, deploys, dropped, facts.stage, messages],
  );
  const proposal = useMemo(
    () => openProposal(messages, proposals, scope),
    [messages, proposals, scope],
  );

  // A retry after the commit landed builds on it, so the deploy runs again.
  const commitProposal = useCallback(
    async (
      messageId: string,
      action: Extract<CopilotAction, { type: "commitFiles" }>,
      landed: string | undefined,
      startedAt: number,
    ): Promise<DockApply> => {
      if (!projectId || !currentStageId) {
        throw new Error("Open the project's stage first.");
      }
      const result = await commitChange({
        baseSha: landed ?? action.baseSha,
        branch: action.branch,
        files: action.files
          .filter((file) => !landed || file.content !== null)
          .map((file) => ({ content: file.content, path: file.path })),
        fullName: action.fullName,
        message: action.message,
        projectId: projectId,
        stageId: currentStageId,
      });
      if (result.viaPullRequest) {
        return {
          phase: "deployed",
          runUrl: result.url,
          sha: result.sha,
          startedAt: startedAt,
        };
      }
      setCommits((prev) => [
        ...prev,
        {
          branch: action.branch,
          committedAt: Date.now(),
          messageId: messageId,
          sha: result.sha,
        },
      ]);

      return { phase: "applying", sha: result.sha, startedAt: startedAt };
    },
    [commitChange, currentStageId, projectId],
  );

  // A proposal being applied ignores a second press and a Discard until it settles.
  const applying = useRef(new Set<string>());
  const applyProposal = useCallback(
    (messageId: string): void => {
      const target = proposals.get(messageId);
      const asked = messages.find((message) => message.id === messageId);
      if (!target || applying.current.has(messageId)) return;
      if (asked?.scope !== undefined && asked.scope !== scope) return;
      applying.current.add(messageId);
      const landed = target.apply.sha;
      const startedAt = Date.now();
      const record = (apply: DockApply): void =>
        setApplies((prev) => ({ ...prev, [messageId]: apply }));
      record({ phase: "applying", startedAt: startedAt });

      void (async (): Promise<DockApply> => {
        // A retry skips the steps an earlier press already ran.
        for (const { action, index } of target.changes) {
          const key = changeKey(messageId, index);
          if (action.type === "commitFiles") {
            return await commitProposal(messageId, action, landed, startedAt);
          }
          if (completed.has(key)) continue;
          if (!(await perform(action))) {
            throw new Error(`${action.label} cannot run here.`);
          }
          setCompleted((prev) => new Set(prev).add(key));
        }

        return { phase: "deployed", startedAt: startedAt };
      })()
        .then(record, (error: unknown) =>
          record({
            error: toErrorMessage(error),
            phase: "failed",
            sha: landed,
            startedAt: startedAt,
          }),
        )
        .finally(() => applying.current.delete(messageId));
    },
    [commitProposal, completed, messages, perform, proposals, scope],
  );

  const discardProposal = useCallback(
    (messageId: string): void => {
      if (applying.current.has(messageId)) return;
      setApplies((prev) => ({
        ...prev,
        [messageId]: {
          phase: "discarded",
          sha: proposals.get(messageId)?.apply.sha,
        },
      }));
    },
    [proposals],
  );

  const dropChange = useCallback(
    (messageId: string, index: number, path?: string): void => {
      if (applying.current.has(messageId)) return;
      setDropped((prev) =>
        new Set(prev).add(changeKey(messageId, index, path)),
      );
    },
    [],
  );

  const runAction = useCallback(
    (action: CopilotAction): void => {
      void performNoted(action);
    },
    [performNoted],
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
      applyProposal: applyProposal,
      ask: ask,
      completed: completed,
      discardProposal: discardProposal,
      dropChange: dropChange,
      isOpen: isOpen,
      items: items,
      messages: shownMessages,
      proposal: proposal,
      proposals: proposals,
      runAction: runAction,
      setOpen: setOpen,
      wakeIndex: wakeIndex,
    }),
    [
      applyProposal,
      ask,
      completed,
      discardProposal,
      dropChange,
      isOpen,
      items,
      proposal,
      proposals,
      runAction,
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
  // Its own context, so the canvas renders when the drawn nodes change, not on every stream delta.
  const nodes = proposedNodes(value.proposal);
  const failed = value.proposal?.apply.phase === "failed";
  const drawn = useMemo(
    () => ({ failed: failed, nodes: nodes }),
    [failed, nodes],
  );

  return (
    <CopilotContext.Provider value={value}>
      <ProposedNodesContext.Provider value={drawn}>
        {children}
      </ProposedNodesContext.Provider>
    </CopilotContext.Provider>
  );
}

/** The nodes the open proposal draws on the canvas; none outside the provider. */
export function useProposedNodes(): ProposedNodes {
  return useContext(ProposedNodesContext);
}

export function useCopilot(): CopilotState {
  const state = useContext(CopilotContext);
  if (!state) throw new Error("useCopilot must be used inside CopilotProvider");

  return state;
}
