/**
 * Parent-dispatched subagent tool.
 * Keep model-facing input validation here; execution orchestration lives in the harness.
 */

import { jsonSchema, tool, type JSONSchema7, type JSONValue, type ModelMessage, type SystemModelMessage, type ToolSet } from "ai";

const MAX_SUBAGENT_TASKS = 10;
const TASK_KEYS = new Set(["agentId", "prompt", "conversationKey"]);
type RunSubagentMode = "ephemeral" | "persistent";

export function buildRunSubagentInputSchema(mode?: RunSubagentMode): JSONSchema7 {
  const taskProperties: Record<string, JSONSchema7> = {
    agentId: {
      type: "string",
      description: "Exact predefined subagent id to use. Include it when a listed subagent is suitable; omit only for a virtual one-shot subagent.",
    },
    prompt: {
      type: "string",
      description: "The task prompt for the subagent.",
    },
  };

  if (mode === "persistent") {
    taskProperties.conversationKey = {
      type: "string",
      description: "Existing subagent conversation key to resume. Omit to start a new persistent conversation.",
    };
  }

  return {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: MAX_SUBAGENT_TASKS,
        items: {
          type: "object",
          properties: taskProperties,
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  };
}

export interface RunSubagentTaskInput {
  agentId?: string;
  prompt: string;
  conversationKey?: string;
}

export interface RunSubagentTaskDispatch {
  taskId: string;
  agentId: string;
  description?: string;
  conversationKey: string;
  statusPath: string;
  status: "running";
}

export interface RunSubagentDispatchResult {
  tasks: RunSubagentTaskDispatch[];
}

export type RunSubagentDispatch = (
  tasks: RunSubagentTaskInput[],
  parentMessages: ModelMessage[],
  parentEphemeralSystem?: SystemModelMessage[],
) => Promise<RunSubagentDispatchResult>;

export default function runSubagentTool(context: {
  dispatchSubagents: RunSubagentDispatch;
  mode?: RunSubagentMode;
}): ToolSet {
  return {
    run_subagent: tool({
      description: [
        "Dispatch one or more subagents for independent parallel work.",
        "Returns task ids immediately so you can continue working while results are injected into the parent conversation later.",
        "Use an available predefined agentId when a listed subagent matches the task; omit agentId only for a virtual one-shot subagent.",
        ...(context.mode === "persistent"
          ? ["Use conversationKey to resume an existing persistent subagent conversation; omit it to start a new one."]
          : []),
      ].join(" "),
      inputSchema: jsonSchema(buildRunSubagentInputSchema(context.mode)),
      async execute(input, options) {
        const tasks = normalizeInput(input, context.mode);
        // Keep the tool as a thin AI SDK adapter. The dispatcher starts child
        // runs and coordinates later parent continuation outside this file.
        return context.dispatchSubagents(tasks, options.messages);
      },
      toModelOutput: ({ output }) => ({
        type: "json",
        value: output as unknown as JSONValue,
      }),
    }),
  };
}

function normalizeInput(input: unknown, mode?: RunSubagentMode): RunSubagentTaskInput[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as { tasks?: unknown }).tasks)) {
    throw new Error("tasks must be a non-empty array");
  }

  const tasks = (input as { tasks: unknown[] }).tasks;
  if (tasks.length === 0) {
    throw new Error("tasks must include at least one subagent task");
  }
  if (tasks.length > MAX_SUBAGENT_TASKS) {
    throw new Error(`tasks must include at most ${MAX_SUBAGENT_TASKS} subagent tasks`);
  }

  return tasks.map((task, index) => normalizeTask(task, index, mode));
}

function normalizeTask(value: unknown, index: number, mode?: RunSubagentMode): RunSubagentTaskInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`tasks[${index}] must be an object`);
  }

  const task = value as Record<string, unknown>;
  for (const key of Object.keys(task)) {
    if (!TASK_KEYS.has(key)) {
      throw new Error(`tasks[${index}].${key} is not supported`);
    }
  }

  const prompt = normalizeRequiredString(task.prompt, `tasks[${index}].prompt`);
  const agentId = normalizeOptionalString(task.agentId, `tasks[${index}].agentId`);
  if (mode !== "persistent" && task.conversationKey !== undefined) {
    throw new Error(`tasks[${index}].conversationKey is only supported in persistent mode`);
  }
  const conversationKey = mode === "persistent"
    ? normalizeOptionalString(task.conversationKey, `tasks[${index}].conversationKey`)
    : undefined;

  return {
    ...(agentId ? { agentId } : {}),
    prompt,
    ...(conversationKey ? { conversationKey } : {}),
  };
}

function normalizeRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
