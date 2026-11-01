import { pruneSessionMessages } from "../../apps/core/src/harness/pruning.ts";
import type { AgentConfig } from "../../apps/core/src/shared/domain/agent-config.ts";
import type { BenchCase } from "../runner.ts";

// `ai` is a core dependency, not a root one: take the type from the function under test.
type ModelMessage = Parameters<typeof pruneSessionMessages>[0][number];

// Not a stored-item provider, so reasoning is stripped: the default path and the most work.
const AGENT_CONFIG: AgentConfig = {
  model: { provider: "anthropic", modelId: "claude-opus-5" },
};

// Two sizes of one history: a superlinear regression moves the long case, not the short.
const SHORT_CONVERSATION: readonly ModelMessage[] = buildConversation(10);
const LONG_CONVERSATION: readonly ModelMessage[] = buildConversation(50);

export const coreSessionCases: readonly BenchCase[] = [
  {
    name: "core/session-prune-40-messages",
    iterations: 2_000,
    run: (): unknown =>
      pruneSessionMessages([...SHORT_CONVERSATION], AGENT_CONFIG),
  },
  {
    name: "core/session-prune-200-messages",
    iterations: 500,
    run: (): unknown =>
      pruneSessionMessages([...LONG_CONVERSATION], AGENT_CONFIG),
  },
];

function buildConversation(turns: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({
      role: "user",
      content: `Check the deployment status for service ${turn} and summarize what changed.`,
    });
    messages.push({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: `The user wants the status of service ${turn}. I should read the rollout record before answering, since the cached view lags behind by a minute and they asked about what changed.`,
        },
        {
          type: "tool-call",
          toolCallId: `call_${turn}`,
          toolName: "bash",
          input: { command: `kubectl rollout status deploy/service-${turn}` },
        },
      ],
    });
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call_${turn}`,
          toolName: "bash",
          output: {
            type: "text",
            value: `deployment "service-${turn}" successfully rolled out\n3 of 3 replicas updated`,
          },
        },
      ],
    });
    messages.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Service ${turn} finished rolling out; all 3 replicas are on the new revision.`,
        },
      ],
    });
  }

  return messages;
}
