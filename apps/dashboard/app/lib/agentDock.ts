import type { CopilotAction, CopilotPlan } from "@/app/lib/copilotActions";
import { planFromQuery, type CopilotContext } from "@/app/lib/copilotIntent";
import type { api } from "@broods/convex/_generated/api";
import { USER_TOKEN_HEADER } from "@broods/convex/model/userToken";
import type { TextStreamPart, ToolSet } from "ai";
import type { FunctionReturnType } from "convex/server";
import { structuredPatch } from "diff";
import { z } from "zod";
import { draftChanges, type DockFile } from "@/app/lib/dockSource";
import { ACCOUNT_NAV_ITEMS, NAV_ITEMS, navHref } from "@/app/lib/navigation";
import { readSseStream } from "../../../../packages/broods/src/stream";

export const PROPOSE_TOOL = "dock__propose_changes";

const MAX_CONTEXT_ITEMS = 150;

export type DockSession = NonNullable<
  FunctionReturnType<typeof api.agentDock.session>
>;

export type DockRepo = NonNullable<
  FunctionReturnType<typeof api.agentDock.repoFiles>
>;

export interface DockFacts {
  /** The branch this stage deploys from, when its project is linked. */
  branch?: string;
  /** Labels of nodes a `broods/` folder or the account API owns; the canvas cannot change them. */
  codeNodes: readonly string[];
  /** `source → target` labels of the canvas edges. */
  connections: readonly string[];
  /** The dashboard path and search the user is on. */
  page?: string;
  project?: string;
  projectId?: string;
  /** One line on what the stage runs: its source revision, how its deploy went, any drift. */
  progress?: string;
  /** `owner/name`, with the branch each stage deploys from. */
  repo?: string;
  stage?: string;
  stageId?: string;
}

// The dock has no question card yet: a question reads as text the user answers by typing.
const questionsSchema = z.object({
  questions: z.array(
    z.object({
      options: z.array(z.object({ label: z.string() })),
      question: z.string(),
    }),
  ),
});

// A malformed node list drops the nodes, never the proposal.
const proposalSchema = z.object({
  files: z
    .array(z.object({ content: z.string().nullable(), path: z.string() }))
    .max(10)
    .default([]),
  message: z.string().max(200).default(""),
  nodes: z
    .array(
      z.object({
        change: z.enum(["add", "remove"]),
        connectTo: z.string().max(100).optional(),
        kind: z.enum(["agent", "mcp", "sandbox", "skill", "workspace"]),
        name: z.string().max(100),
      }),
    )
    .max(10)
    .catch([]),
  steps: z.array(z.string().max(200)).max(8).default([]),
  summary: z.string().max(500),
});

// Names only: each step the agent proposes resolves through the planner, like a typed ask.
export function dockPrompt(
  query: string,
  context: CopilotContext,
  facts: DockFacts,
  repo?: DockRepo,
): string {
  const lines = [
    `Project: ${facts.project ?? "none open"}, stage: ${facts.stage ?? "unknown"}`,
    ...(facts.page ? [`On page: ${facts.page}`] : []),
    ...(facts.projectId
      ? [`Ids: project ${facts.projectId}, stage ${facts.stageId ?? "default"}`]
      : []),
    pagesLine(facts),
    ...(facts.progress ? [facts.progress] : []),
    facts.repo
      ? `Deploys from GitHub ${facts.repo}: resources defined in its broods/ folder change in code, not on the canvas.`
      : facts.codeNodes.length > 0
        ? "Not linked to GitHub: code-defined resources change only where `broods deploy` runs. Settings > Git links a repo so you can commit."
        : "Not linked to GitHub: the canvas is the source of truth.",
    ...context.items.slice(0, MAX_CONTEXT_ITEMS).map((item) => {
      const notes = [
        item.detail,
        item.group === "Nodes" && facts.codeNodes.includes(item.title)
          ? "defined in code, the canvas cannot change it"
          : undefined,
      ].filter(Boolean);

      return `- ${item.group}: ${item.title}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
    }),
    ...facts.connections.map((edge) => `- Connected: ${edge}`),
    ...context.envNames.map((name) => `- Env var on this stage: ${name}`),
  ];

  const files = repo
    ? `\n<repo-files repo="${repo.fullName}" branch="${repo.branch}">\n${repo.files
        .map((file) => `--- ${file.path}\n${file.content}`)
        .join(
          "\n",
        )}${repo.omitted > 0 ? `\n(${repo.omitted} more files not shown: ask before editing them.)` : ""}\n</repo-files>`
    : "";

  return `${query}\n\n<dashboard-context>\n${lines.join("\n")}\n</dashboard-context>${files}`;
}

// A step the planner cannot resolve stays visible as blocked, so nothing is silently dropped.
export function proposalPlan(
  input: unknown,
  context: CopilotContext,
  repo?: DockRepo,
): CopilotPlan | null {
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) return null;
  const { files, message, nodes } = parsed.data;
  const label = `Commit ${files.map((file) => file.path).join(", ")}`;
  const read = new Set(repo?.files.map((file) => file.path));
  // With files left out of the read, an unread path may exist and would be overwritten blind.
  const unread =
    repo && repo.omitted > 0
      ? files.find((file) => !read.has(file.path))
      : undefined;
  const missing = repo
    ? files.find((file) => file.content === null && !read.has(file.path))
    : undefined;
  const twice = files.find(
    (file, index) =>
      files.findIndex((other) => other.path === file.path) !== index,
  );
  const refusal = twice
    ? `${twice.path} is listed twice. Ask again.`
    : unread
      ? `${unread.path} was not among the files the agent read. Ask it to edit only files it was shown.`
      : missing
        ? `${missing.path} is not in the repo, so it cannot be deleted.`
        : undefined;
  const commit: CopilotAction[] =
    files.length === 0
      ? []
      : repo && !refusal
        ? [commitAction(files, message, repo)]
        : [
            {
              label: label,
              reason:
                refusal ??
                "The repo could not be read, so this edit cannot be applied. Ask again.",
              type: "blocked",
            },
          ];

  return {
    actions: [
      ...parsed.data.steps.flatMap(
        (step) =>
          planFromQuery(step, context)?.actions ?? [
            {
              label: step,
              reason: "Not found in this project.",
              type: "blocked" as const,
            },
          ],
      ),
      ...commit,
    ],
    nodes: nodes,
    summary: parsed.data.summary,
  };
}

/** What the agent reads of the stage's state: the same facts the change bar shows the user. */
export function stageProgress(
  source:
    | {
        commitSha?: string;
        origin: string;
        revision: number;
        verification?: { error?: string; phase: string };
      }
    | null
    | undefined,
  driftReason: string | undefined,
): string | undefined {
  if (!source) return undefined;
  const { commitSha, origin, revision, verification } = source;
  const parts = [
    `Stored source: revision ${revision}, from ${origin}`,
    ...(commitSha ? [`commit ${commitSha.slice(0, 7)}`] : []),
    ...(verification
      ? [
          `deploy ${verification.phase}${verification.error ? `: ${verification.error}` : ""}`,
        ]
      : []),
    ...(driftReason ? [`out of sync: ${driftReason}`] : []),
  ];

  return parts.join(", ");
}

/**
 * A proposal from the agent's workspace: its canvas steps, plus the diff between the source the
 * conversation was seeded with and the draft it left, deletes included.
 */
export function sourcePlan(
  input: unknown,
  context: CopilotContext,
  seed: {
    branch?: string;
    files: readonly DockFile[];
    revision: number | null;
  },
  draft: readonly DockFile[],
): CopilotPlan | null {
  const parsed = proposalSchema.safeParse(input);
  const steps = proposalPlan(
    parsed.success ? { ...parsed.data, files: [] } : input,
    context,
  );
  if (!steps || !parsed.success) return null;
  const changes = draftChanges(seed.files, draft);
  if (changes.length === 0) return steps;
  const message = parsed.data.message || parsed.data.summary;

  return {
    ...steps,
    actions: [
      ...steps.actions,
      {
        files: changes.map((change) => ({
          content: change.change === "delete" ? null : change.after,
          patch: filePatch(change.path, change.before, change.after),
          path: change.path,
        })),
        label: `Deploy ${changes.length} ${changes.length === 1 ? "file" : "files"}: ${message}`,
        message: message,
        type: "commitFiles",
        via: {
          baseRevision: seed.revision,
          ...(seed.branch ? { branch: seed.branch } : {}),
          kind: "source",
          seed: seed.files,
        },
      },
    ],
  };
}

export function questionText(input: unknown): string {
  const parsed = questionsSchema.safeParse(input);
  if (!parsed.success) return "";

  return parsed.data.questions
    .map(
      (question) =>
        `${question.question}\n${question.options.map((option) => `- ${option.label}`).join("\n")}`,
    )
    .join("\n\n");
}

// One turn of the dock's conversation, as the signed-in user; parts arrive as the model streams.
export async function* streamDockAnswer(
  session: DockSession,
  conversationKey: string,
  signal: AbortSignal,
  text: string,
): AsyncGenerator<TextStreamPart<ToolSet>> {
  const response = await fetch(session.url, {
    signal: signal,
    body: JSON.stringify({
      agentId: session.agentId,
      conversationKey: conversationKey,
      eventId: `dock-${crypto.randomUUID()}`,
      events: [{ content: [{ text: text, type: "text" }], role: "user" }],
      stream: true,
    }),
    headers: {
      Authorization: `Bearer ${session.runtimeKey}`,
      "Content-Type": "application/json",
      [USER_TOKEN_HEADER]: session.userToken,
    },
    method: "POST",
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(body.error?.message ?? `Status ${response.status}`);
  }

  for await (const data of readSseStream(response.body)) {
    const part = JSON.parse(data) as TextStreamPart<ToolSet>;
    if (part.type === "error") throw new Error(String(part.error));
    yield part;
  }
}

// The sections dock__navigate can open, from the sidebar's own items.
function pagesLine(facts: DockFacts): string {
  const { projectId } = facts;
  const pages = [
    ...(projectId
      ? NAV_ITEMS.map((item) => ({
          path: navHref(projectId, item.segment, facts.stageId ?? null),
          tabs: item.tabs,
          label: item.label,
        }))
      : []),
    ...ACCOUNT_NAV_ITEMS.map((item) => ({ ...item, path: item.segment })),
  ];

  return `Pages: ${pages
    .map(
      (page) =>
        `${page.label} ${page.path}${page.tabs.length > 0 ? ` (tab=${page.tabs.map((tab) => tab.id).join("|")})` : ""}`,
    )
    .join("; ")}`;
}

function commitAction(
  files: readonly { content: string | null; path: string }[],
  message: string,
  repo: DockRepo,
): CopilotAction {
  const before = new Map(repo.files.map((file) => [file.path, file.content]));

  return {
    files: files.map((file) => ({
      content: file.content,
      patch: filePatch(
        file.path,
        before.get(file.path) ?? "",
        file.content ?? "",
      ),
      path: file.path,
    })),
    label: `Commit to ${repo.branch}: ${message || "update broods/"}`,
    message: message,
    type: "commitFiles",
    via: {
      baseSha: repo.baseSha,
      branch: repo.branch,
      fullName: repo.fullName,
      kind: "github",
    },
  };
}

// Changed lines, unified-diff style, led by `@@ old → new`.
function filePatch(path: string, before: string, after: string): string[] {
  return structuredPatch(
    path,
    path,
    withNewline(before),
    withNewline(after),
    undefined,
    undefined,
    { context: 2 },
  ).hunks.flatMap((hunk) => [
    `@@ ${hunk.oldStart},${hunk.oldLines} → ${hunk.newStart},${hunk.newLines}`,
    ...hunk.lines,
  ]);
}

// A missing final newline would mark the last line changed on both sides.
function withNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}
