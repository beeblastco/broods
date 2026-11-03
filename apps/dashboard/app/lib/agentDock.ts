import type { CopilotPlan } from "@/app/lib/copilotActions";
import { planFromQuery, type CopilotContext } from "@/app/lib/copilotIntent";
import { agentEndpointPath } from "@/app/lib/coreEndpoint";
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

const proposalSchema = z.object({
  summary: z.string().max(500),
  steps: z.array(z.string().max(200)).max(8),
});

// Names only: each step the agent proposes resolves through the planner, like a typed ask.
export function dockPrompt(query: string, context: CopilotContext): string {
  const lines = [
    ...context.items
      .slice(0, MAX_CONTEXT_ITEMS)
      .map((item) => `- ${item.group}: ${item.title}`),
    ...context.crons.map((cron) => `- Cron: ${cron.name} (${cron.status})`),
    ...context.envNames.map((name) => `- Env var on this stage: ${name}`),
  ];

  return `${query}\n\n<dashboard-context>\nWhat the user's project shows right now:\n${lines.join("\n") || "- nothing yet"}\n</dashboard-context>`;
}

// A step the planner cannot resolve stays visible as blocked, so nothing is silently dropped.
export function proposalPlan(
  input: unknown,
  context: CopilotContext,
): CopilotPlan | null {
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) return null;

  return {
    actions: parsed.data.steps.flatMap(
      (step) =>
        planFromQuery(step, context)?.actions ?? [
          {
            label: step,
            reason: "Not found in this project.",
            type: "blocked",
          },
        ],
    ),
    summary: parsed.data.summary,
  };
}

// One turn of the dock's conversation, as the signed-in user; parts arrive as the model streams.
export async function* streamDockAnswer(
  session: DockSession,
  baseUrl: string,
  conversationKey: string,
  text: string,
): AsyncGenerator<TextStreamPart<ToolSet>> {
  const response = await fetch(`${baseUrl}${agentEndpointPath(session)}`, {
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
