import type { CopilotAction, CopilotPlan } from "@/app/lib/copilotActions";
import { planFromQuery, type CopilotContext } from "@/app/lib/copilotIntent";
import type { api } from "@broods/convex/_generated/api";
import { USER_TOKEN_HEADER } from "@broods/convex/model/userToken";
import type { TextStreamPart, ToolSet } from "ai";
import type { FunctionReturnType } from "convex/server";
import { z } from "zod";
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
  /** Labels of nodes a `broods/` folder or the account API owns; the canvas cannot change them. */
  codeNodes: readonly string[];
  /** `source → target` labels of the canvas edges. */
  connections: readonly string[];
  project?: string;
  /** `owner/name`, with the branch each stage deploys from. */
  repo?: string;
  stage?: string;
}

export const ASK_TOOL = "ask_questions";

// The dock has no question card yet: a question reads as text the user answers by typing.
const questionsSchema = z.object({
  questions: z.array(
    z.object({
      options: z.array(z.object({ label: z.string() })),
      question: z.string(),
    }),
  ),
});

const proposalSchema = z.object({
  files: z
    .array(z.object({ content: z.string(), path: z.string() }))
    .max(10)
    .default([]),
  message: z.string().max(200).default(""),
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
    facts.repo
      ? `Deploys from GitHub ${facts.repo}: resources defined in its broods/ folder change in code, not on the canvas.`
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
  const { files, message } = parsed.data;
  const commit: CopilotAction[] =
    files.length === 0
      ? []
      : repo
        ? [commitAction(files, message, repo)]
        : [
            {
              label: `Commit ${files.map((file) => file.path).join(", ")}`,
              reason:
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
    summary: parsed.data.summary,
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
  text: string,
): AsyncGenerator<TextStreamPart<ToolSet>> {
  const response = await fetch(session.url, {
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

function commitAction(
  files: readonly { content: string; path: string }[],
  message: string,
  repo: DockRepo,
): CopilotAction {
  const before = new Map(repo.files.map((file) => [file.path, file.content]));
  const lines = (text: string | undefined): number =>
    text === undefined ? 0 : text.split("\n").length;

  return {
    baseSha: repo.baseSha,
    branch: repo.branch,
    change: {
      after: `${files.reduce((sum, file) => sum + lines(file.content), 0)} lines`,
      before: `${files.reduce((sum, file) => sum + lines(before.get(file.path)), 0)} lines`,
      field: files.map((file) => file.path).join(", "),
    },
    files: files,
    label: `Commit to ${repo.branch}: ${message || "update broods/"}`,
    message: message,
    type: "commitFiles",
  };
}
