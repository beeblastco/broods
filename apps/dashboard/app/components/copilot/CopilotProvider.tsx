"use client";

import { useShortcutRegistry } from "@/app/components/ShortcutProvider";
import { useDashboardIndex } from "@/app/hooks/useDashboardIndex";
import { useSignedIn } from "@/app/hooks/useSignedIn";
import { useStage } from "@/app/hooks/useStage";
import type { DockFacts, DockSession } from "@/app/lib/agentDock";
import type { DockFile } from "@/app/lib/dockSource";
import type { DockAnswer, DockTracePart } from "@/app/lib/dockTrace";
import {
  actionTier,
  changeKey,
  dockProposals,
  openProposal,
  proposedNodes,
  settleApplies,
  settleVerified,
  trackDeploy,
  type CopilotAction,
  type CopilotPlan,
  type DockApply,
  type DockProposal,
  type ProposedNode,
  type TrackedDeploy,
} from "@/app/lib/copilotActions";
import type { CopilotContext } from "@/app/lib/copilotIntent";
import { navHref } from "@/app/lib/navigation";
import { requestCanvasAction } from "@/app/lib/canvasActions";
import { toErrorMessage } from "@/app/lib/errors";
import type { SearchItem } from "@/app/lib/paletteSearch";
import { STREAM_COMMIT_MS } from "@/app/lib/perfReport";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
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

// A session minted this close to expiry is renewed before the next ask.
const SESSION_RENEW_MS = 60 * 1000;

export interface CopilotMessage {
  /** When the final text began after the last trace step; unset while it still works. */
  answeredAt?: number;
  id: string;
  /** Set while the Broods agent has not answered yet. */
  pending?: boolean;
  plan?: CopilotPlan;
  role: "user" | "broods";
  /** The project and stage it was asked on; its writes refuse to run anywhere else. */
  scope?: string;
  stale?: boolean;
  startedAt?: number;
  text: string;
  /** Reasoning and tool steps, in stream order. */
  trace?: readonly DockTracePart[];
}

export interface CopilotState {
  applyProposal: (messageId: string) => void;
  /** Out of sync, and why; null while it is in sync or not read yet. */
  drift: { reason?: string; syncing: boolean } | null;
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
  /** Puts the stage back on the source the proposal was seeded from. */
  revertProposal: (messageId: string) => void;
  setOpen: (open: boolean) => void;
  /** Ends the answer being streamed; what arrived stays in the thread. */
  stop: () => void;
  /** Redeploys the stage's right source: the branch head when linked, else the stored one. */
  syncStage: () => void;
  wakeIndex: () => void;
}

/** The source a dock conversation was seeded with; its draft is diffed against it. */
interface DockSeed {
  branch?: string;
  files: readonly DockFile[];
  revision: number | null;
}

interface SeededFolder {
  seed: DockSeed;
  stageId: string;
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
  const projects = useQuery(
    api.dashboardReads.projects,
    indexedProject ? {} : "skip",
  );
  const stages = useQuery(
    api.dashboardReads.stages,
    indexedProject ? { projectId: indexedProject } : "skip",
  );
  const facts = useMemo((): Omit<DockFacts, "codeNodes"> => {
    const labels = new Map(
      (canvas?.nodes ?? []).map((node) => [
        node.id,
        typeof node.data.label === "string" ? node.data.label : node.id,
      ]),
    );
    const project = projects?.find((entry) => entry._id === projectId);
    const repo = project?.repo;
    const branches = [
      repo?.productionBranch && `Production from ${repo.productionBranch}`,
      repo?.developmentBranch && `Development from ${repo.developmentBranch}`,
    ].filter(Boolean);

    const stage = stages?.find((entry) =>
      stageId ? entry._id === stageId : entry.isDefault,
    );
    const branch =
      stage?.kind === "production"
        ? repo?.productionBranch
        : repo?.developmentBranch;

    return {
      ...(branch ? { branch: branch } : {}),
      connections: (canvas?.edges ?? []).map(
        (edge) =>
          `${labels.get(edge.source) ?? edge.source} → ${labels.get(edge.target) ?? edge.target}`,
      ),
      project: project?.name,
      repo: repo ? `${repo.fullName} (${branches.join(", ")})` : undefined,
      ...(projectId ? { projectId: projectId } : {}),
      ...(project ? { projectSlug: project.slug } : {}),
      stage: stage?.name,
      ...(stage ? { stageId: stage._id } : {}),
    };
  }, [canvas, projectId, projects, stageId, stages]);
  const updateCron = useMutation(api.agent.cronsPublic.update);
  const setEnvVar = useMutation(api.environmentVariables.set);
  const mintSession = useMutation(api.agentDock.session);
  const commitChange = useAction(api.agentDock.commitChange);
  const readRepo = useAction(api.agentDock.repoFiles);
  const convex = useConvex();
  const applySource = useAction(api.agentDock.apply);
  const syncSource = useAction(api.agentDock.sync);
  const currentStageId =
    stageId ?? stages?.find((stage) => stage.isDefault)?._id ?? null;
  // The user menu's subscription. A session lends the open project's org, else the active one.
  const activeOrg = useQuery(
    api.dashboardReads.activeOrg,
    useSignedIn() ? {} : "skip",
  );
  const orgId = activeOrg?._id;
  const sessionKey = `${projectId ?? ""}:${orgId ?? ""}`;
  const sessionRef = useRef<{
    key: string;
    session: DockSession | null;
  } | null>(null);
  const streamRef = useRef<AbortController | null>(null);
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
    () => commits.map((commit) => trackDeploy(commit, github?.deploys)),
    [commits, github],
  );

  // Once the dock woke: the cold canvas subscribes to nothing it does not draw.
  const sourceArgs =
    indexAwake && currentStageId ? { stageId: currentStageId } : "skip";
  const source = useQuery(api.stageSources.latest, sourceArgs);
  const driftState = useQuery(api.stageSources.drift, sourceArgs);
  const [syncing, setSyncing] = useState(false);
  const drift = useMemo(
    () =>
      driftState?.outOfSync || syncing
        ? {
            ...(driftState?.reason ? { reason: driftState.reason } : {}),
            syncing: syncing,
          }
        : null,
    [driftState, syncing],
  );
  // The conversation has one folder, so only the last stage written to it is trusted.
  const folder = useRef<SeededFolder | null>(null);

  // Adjusted during render: a finished run is kept, so a later push cannot reopen it.
  const settled = settleApplies(applies, deploys);
  if (settled) setApplies(settled);
  const verified = settleVerified(applies, source, Date.now());
  if (verified) setApplies(verified);

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
    const held = sessionRef.current;
    const cached = held && held.key === sessionKey ? held.session : undefined;
    if (
      cached === null ||
      (cached && cached.expiresAt - SESSION_RENEW_MS > Date.now())
    ) {
      return cached;
    }
    try {
      const session = await mintSession({
        conversationKey: conversationKey,
        ...(projectId ? { projectId: projectId } : {}),
      });
      sessionRef.current = { key: sessionKey, session: session };

      return session;
    } catch {
      return null;
    }
  }, [conversationKey, mintSession, projectId, sessionKey]);

  const askAgent = useCallback(
    async (
      replyId: string,
      query: string,
      context: CopilotContext,
      dockFacts: DockFacts,
      session: DockSession,
      controller: AbortController,
    ): Promise<void> => {
      const update = (patch: Partial<CopilotMessage>): void =>
        setMessages((prev) =>
          prev.map((message) =>
            message.id === replyId ? { ...message, ...patch } : message,
          ),
        );
      let answer: DockAnswer = { text: "", trace: [] };
      let plan: CopilotPlan | undefined;
      let answeredAt: number | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        controller.signal.throwIfAborted();
        // Lazy: zod and the stream reader load on the first ask, not with every page.
        const {
          dockPrompt,
          PROPOSE_TOOL,
          proposalPlan,
          questionText,
          sourcePlan,
          stageProgress,
          streamDockAnswer,
        } = await import("@/app/lib/agentDock");
        const { answerStep, ASK_TOOL, NAVIGATE_TOOL, navigatePath } =
          await import("@/app/lib/dockTrace");
        const { readDraft, reseedConversation } =
          await import("@/app/lib/dockSource");
        // The stored source goes in the agent's own folder; an agent with none reads the repo.
        // An ask right after the dock opens beats the subscription: read it instead of skipping.
        const stored =
          source === undefined && currentStageId
            ? await convex
                .query(api.stageSources.latest, { stageId: currentStageId })
                .catch((): null => null)
            : source;
        const held =
          folder.current?.stageId === currentStageId ? folder.current : null;
        // A Revert, a deploy or a push stored a newer revision: the agent's edits move onto it.
        if (
          currentStageId &&
          stored?.url &&
          (!held || stored.revision > (held.seed.revision ?? 0))
        ) {
          folder.current = await reseedConversation(
            session,
            conversationKey,
            stored.url,
            held?.seed.files,
            controller.signal,
          )
            .then(({ files, lost }): SeededFolder => {
              if (lost.length > 0)
                note(
                  `The stage's source moved to revision ${stored.revision} and changed ${lost.join(", ")}, so the agent's edits there were dropped.`,
                );

              return {
                seed: {
                  files: files,
                  revision: stored.revision,
                  ...(dockFacts.branch ? { branch: dockFacts.branch } : {}),
                },
                stageId: currentStageId,
              };
            })
            .catch((): null => null);
        }
        const seeded =
          currentStageId && folder.current?.stageId === currentStageId
            ? folder.current.seed
            : undefined;
        // A linked repo's broods/ folder is what the agent edits; without it, it only advises.
        const repo =
          !seeded && dockFacts.repo && projectId && currentStageId
            ? await readRepo({
                projectId: projectId,
                stageId: currentStageId,
              }).catch((error: unknown) => {
                note(
                  `Could not read ${dockFacts.repo}: ${toErrorMessage(error)}`,
                );

                return null;
              })
            : null;
        controller.signal.throwIfAborted();
        const stream = streamDockAnswer(
          session,
          conversationKey,
          controller.signal,
          dockPrompt(
            query,
            context,
            {
              ...dockFacts,
              page: `${window.location.pathname}${window.location.search}`,
              progress: stageProgress(stored, driftState?.reason),
            },
            repo ?? undefined,
          ),
        );
        // The agent may edit and propose in one step, so its draft is read once the turn ends.
        let drafted: { input: unknown; seed: DockSeed } | undefined;
        for await (const part of stream) {
          const next = answerStep(answer, part, Date.now());
          const traced = next.trace !== answer.trace;
          answer = next;
          if (traced) answeredAt = undefined;
          if (part.type === "text-delta") {
            if (answer.trace.length > 0) answeredAt ??= Date.now();
          } else if (part.type === "tool-call") {
            if (part.toolName === PROPOSE_TOOL) {
              if (seeded) drafted = { input: part.input, seed: seeded };
              else
                plan =
                  proposalPlan(part.input, context, repo ?? undefined) ?? plan;
            } else if (part.toolName === ASK_TOOL) {
              answer = {
                ...answer,
                text: `${answer.text}${answer.text ? "\n\n" : ""}${questionText(part.input)}`,
              };
            } else if (part.toolName === NAVIGATE_TOOL) {
              const path = navigatePath(part.input);
              if (path) router.push(path);
            }
          } else if (!traced) continue;
          timer ??= setTimeout(() => {
            timer = undefined;
            update({
              answeredAt: answeredAt,
              plan: plan,
              text: answer.text,
              trace: answer.trace,
            });
          }, STREAM_COMMIT_MS);
        }
        clearTimeout(timer);
        if (drafted)
          plan =
            sourcePlan(
              drafted.input,
              context,
              drafted.seed,
              await readDraft(session, conversationKey, controller.signal),
            ) ?? plan;
        update({
          answeredAt: answeredAt ?? Date.now(),
          pending: false,
          plan: plan,
          text: answer.text.trim()
            ? answer.text
            : plan?.summary || answer.interim || "",
          trace: answer.trace,
        });
        if (plan) runSafeSteps(replyId, plan);
      } catch (error) {
        clearTimeout(timer);
        const stopped = controller.signal.aborted;
        update({
          answeredAt: Date.now(),
          pending: false,
          trace: answer.trace,
          text: stopped
            ? `${answer.text}${answer.text ? "\n\n" : ""}Stopped.`
            : `The Broods agent could not answer: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        streamRef.current = null;
      }
    },
    [
      conversationKey,
      convex,
      currentStageId,
      driftState,
      note,
      projectId,
      readRepo,
      router,
      runSafeSteps,
      source,
    ],
  );

  const answering = messages.some((message) => message.pending === true);
  const stop = useCallback((): void => streamRef.current?.abort(), []);

  const ask = useCallback(
    (query: string): void => {
      const trimmed = query.trim();
      if (!trimmed) return;
      // A turn queued behind a running one would reach the agent without the user's login.
      if (answering) {
        note("Wait for the current answer, or stop it.");

        return;
      }

      const askedAt = String(Date.now());
      const replyId = `${askedAt}:broods`;
      setMessages((prev) => [
        ...prev,
        { id: `${askedAt}:you`, role: "user", text: trimmed },
        {
          id: replyId,
          pending: true,
          role: "broods",
          scope: scope,
          startedAt: Number(askedAt),
          text: "",
        },
      ]);

      // Set before the mint, so Stop also ends an answer still being set up.
      const controller = new AbortController();
      streamRef.current = controller;
      // Lazy: the fallback planner and the canvas ownership rules load on the first ask.
      void Promise.all([
        dockSession(),
        import("@/app/lib/copilotIntent"),
        import("@/app/components/canvas/edgeOwnership"),
      ])
        .then(async ([session, intent, { isCodeManagedOwner }]) => {
          const codeNodes = (canvas?.nodes ?? [])
            .filter((node) => isCodeManagedOwner(node.data.managedBy))
            .map((node) =>
              typeof node.data.label === "string" ? node.data.label : node.id,
            );
          const context: CopilotContext = {
            crons: (crons ?? []).map((cron) => ({
              id: cron._id,
              name: cron.name,
              status: cron.status,
            })),
            envNames: (envVars ?? []).map((envVar) => envVar.name),
            items: items,
            liveCommands: registry.activeIds,
            lockedNodes: new Set(codeNodes),
          };
          if (session) {
            const { onFolder } = await import("@/app/lib/dockSource");
            return await onFolder(
              () =>
                askAgent(
                  replyId,
                  trimmed,
                  context,
                  { ...facts, codeNodes: codeNodes },
                  session,
                  controller,
                ),
              controller.signal,
            );
          }

          streamRef.current = null;
          const plan = controller.signal.aborted
            ? null
            : intent.planFromQuery(trimmed, context);
          setMessages((prev) =>
            prev.map((message) =>
              message.id === replyId
                ? {
                    ...message,
                    pending: false,
                    plan: plan ?? undefined,
                    text: controller.signal.aborted
                      ? "Stopped."
                      : (plan?.summary ?? intent.NO_MODEL_REPLY),
                  }
                : message,
            ),
          );
          if (plan) runSafeSteps(replyId, plan);
        })
        .catch((error: unknown) => {
          streamRef.current = null;
          setMessages((prev) =>
            prev.map((message) =>
              message.id === replyId
                ? { ...message, pending: false, text: toErrorMessage(error) }
                : message,
            ),
          );
        });
    },
    [
      answering,
      askAgent,
      canvas,
      crons,
      dockSession,
      envVars,
      facts,
      items,
      note,
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
      const { via } = action;
      if (via.kind === "source") {
        const { draftFiles } = await import("@/app/lib/dockSource");
        const files = draftFiles(via.seed, action.files);
        const applied = await applySource({
          baseRevision: via.baseRevision,
          files: files,
          message: action.message,
          projectId: projectId,
          stageId: currentStageId,
        });
        // The next ask builds on what landed, as the agent's folder already does.
        folder.current = {
          seed: {
            files: files,
            revision: applied.revision,
            ...(via.branch ? { branch: via.branch } : {}),
          },
          stageId: currentStageId,
        };

        return applied.phase === "verifying"
          ? {
              phase: "verifying",
              revision: applied.revision,
              sha: applied.commitSha,
              startedAt: startedAt,
            }
          : {
              finishedAt: Date.now(),
              phase: "deployed",
              revision: applied.revision,
              startedAt: startedAt,
            };
      }
      const prior = await convex.query(api.github.status, {
        projectId: projectId,
      });
      const result = await commitChange({
        baseSha: landed ?? via.baseSha,
        branch: via.branch,
        files: action.files
          .filter((file) => !landed || file.content !== null)
          .map((file) => ({ content: file.content, path: file.path })),
        fullName: via.fullName,
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
          branch: via.branch,
          messageId: messageId,
          priorRunId:
            prior.deploys.find((deploy) => deploy.branch === via.branch)
              ?.runId ?? 0,
          sha: result.sha,
        },
      ]);

      return { phase: "applying", sha: result.sha, startedAt: startedAt };
    },
    [applySource, commitChange, convex, currentStageId, projectId],
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

  const revertProposal = useCallback(
    (messageId: string): void => {
      const commit = proposals
        .get(messageId)
        ?.changes.find(({ action }) => action.type === "commitFiles")?.action;
      if (
        commit?.type !== "commitFiles" ||
        commit.via.kind !== "source" ||
        !projectId ||
        !currentStageId ||
        applying.current.has(messageId)
      )
        return;
      applying.current.add(messageId);
      const startedAt = Date.now();
      const record = (apply: DockApply): void =>
        setApplies((prev) => ({ ...prev, [messageId]: apply }));
      record({ phase: "applying", startedAt: startedAt });
      void applySource({
        baseRevision: applies[messageId]?.revision ?? commit.via.baseRevision,
        files: [...commit.via.seed],
        message: `Revert: ${commit.message}`,
        projectId: projectId,
        stageId: currentStageId,
      })
        .then(
          (): void => record({ phase: "discarded" }),
          (error: unknown): void =>
            record({
              error: toErrorMessage(error),
              phase: "failed",
              startedAt: startedAt,
            }),
        )
        .finally(() => applying.current.delete(messageId));
    },
    [applies, applySource, currentStageId, projectId, proposals],
  );

  const syncStage = useCallback((): void => {
    if (!projectId || !currentStageId || syncing) return;
    setSyncing(true);
    void syncSource({ projectId: projectId, stageId: currentStageId })
      .catch((error: unknown): void =>
        note(`Sync failed: ${toErrorMessage(error)}`),
      )
      .finally(() => setSyncing(false));
  }, [currentStageId, note, projectId, syncSource, syncing]);

  const dropChange = useCallback(
    (messageId: string, index: number, path?: string): void => {
      if (applying.current.has(messageId)) return;
      setDropped((prev) =>
        new Set(prev).add(changeKey(messageId, index, path)),
      );
      const step = proposals
        .get(messageId)
        ?.changes.find((change) => change.index === index)?.action;
      if (
        path === undefined ||
        step?.type !== "commitFiles" ||
        step.via.kind !== "source"
      )
        return;
      // The agent's folder keeps the edit, so the next ask would propose the file again.
      void import("@/app/lib/dockSource")
        .then(({ revertPaths }) =>
          revertPaths(
            dockSession,
            conversationKey,
            () =>
              folder.current?.stageId === currentStageId
                ? folder.current.seed.files
                : undefined,
            [path],
          ),
        )
        .catch((error: unknown): void =>
          note(`Could not drop ${path}: ${toErrorMessage(error)}`),
        );
    },
    [conversationKey, currentStageId, dockSession, note, proposals],
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
      drift: drift,
      dropChange: dropChange,
      isOpen: isOpen,
      items: items,
      messages: shownMessages,
      proposal: proposal,
      proposals: proposals,
      revertProposal: revertProposal,
      runAction: runAction,
      setOpen: setOpen,
      stop: stop,
      syncStage: syncStage,
      wakeIndex: wakeIndex,
    }),
    [
      applyProposal,
      ask,
      completed,
      discardProposal,
      drift,
      dropChange,
      isOpen,
      items,
      proposal,
      proposals,
      revertProposal,
      runAction,
      setOpen,
      shownMessages,
      stop,
      syncStage,
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
