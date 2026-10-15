import type { ObservabilitySpanRow } from "@/app/hooks/useObservabilityStream";

// Long enough for a provider's whole error line, short enough to paste.
const ERROR_CHARS = 500;

// What the prompt asks for, by the task's status.
const ASK: Record<ObservabilitySpanRow["status"], string> = {
  error: "failed. Find out why it failed and fix it.",
  needs_input:
    "stopped to wait for input. Check whether it should have, and fix it if not.",
  waiting:
    "is waiting on a subagent or tool. Check whether it is stuck, and fix it if so.",
  running:
    "is still running. Check it for errors, slow steps or wasted tokens, and suggest fixes.",
  ok: "finished. Audit it for errors, slow steps or wasted tokens, and suggest fixes.",
};

export interface AgentDebugTarget {
  projectSlug: string;
  stageSlug: string;
  root: ObservabilitySpanRow;
  /** The whole task's status, which can differ from its first run's. */
  status: ObservabilitySpanRow["status"];
  /** The task's failure, when it failed. */
  error: string | null;
}

/**
 * A prompt for the user's own coding agent: the run's ids, and how to read the
 * run through the public `broods` CLI. Only ids and the error go in, never
 * prompts, tool data or keys; the agent reads those itself with its own login.
 */
export function agentDebugPrompt({
  projectSlug,
  stageSlug,
  root,
  status,
  error,
}: AgentDebugTarget): string {
  const scope = `--project ${projectSlug} --stage ${stageSlug}`;
  const taskId = root.attributes?.["task.id"];
  const facts = [
    `Project: ${projectSlug}`,
    `Stage: ${stageSlug}`,
    ...(root.agentId ? [`Agent: ${root.agentId}`] : []),
    ...(typeof taskId === "string" ? [`Task ID: ${taskId}`] : []),
    `Trace ID: ${root.traceId}`,
    ...(root.conversationKey ? [`Conversation: ${root.conversationKey}`] : []),
    `Started: ${new Date(root.startTimeMs).toISOString()}`,
    ...(error
      ? [
          `Error: ${error.length > ERROR_CHARS ? `${error.slice(0, ERROR_CHARS)}…` : error}`,
        ]
      : []),
  ];

  return [
    `A run of my Broods agent ${ASK[status]}`,
    "",
    ...facts,
    "",
    `1. Read the run: \`broods trace ${root.traceId} ${scope} --json\`. It prints every model step and tool call with its input, output and error. It needs \`broods login\`; install the CLI with \`npm install -g broods\` if it is missing.`,
    `2. Find the agent: \`broods agent list ${scope}\` maps the agent id to its name in this repo's \`broods/\` folder.`,
    "3. Find the root cause in the trace, then fix it where it lives: the agent's definition (system prompt, tools, sandbox, model settings) or the code that calls it. Point out anything else in the run that is slow, wasteful or risky.",
    "4. Show me the change before syncing or deploying anything.",
  ].join("\n");
}
