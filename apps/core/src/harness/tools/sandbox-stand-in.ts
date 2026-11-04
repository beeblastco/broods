// Client-executed provider tools (the provider defines the schema, the caller runs it), run on
// the agent's sandbox through the Broods tool each one stands for.

import type { AnthropicProvider } from "@ai-sdk/anthropic";
import type { OpenAIProvider } from "@ai-sdk/openai";
import type { InferToolInput, ToolSet } from "ai";
import { toErrorMessage } from "../../shared/errors.ts";
import { configString, shellQuote } from "../sandbox/utils.ts";
import { applyPatchScript } from "./apply-patch.ts";
import {
  resolveWorkspace,
  runSandbox,
  sandboxRunMetadata,
  type SandboxToolContext,
} from "./filesystem-utils.ts";

const TEXT_EDITOR_COMMANDS = new Set(["create", "str_replace", "view"]);

type SandboxToolName = "bash" | "edit" | "read" | "write";

type ExecutionOptions = Parameters<NonNullable<ToolSet[string]["execute"]>>[1];

type ApplyPatchInput = InferToolInput<
  ReturnType<OpenAIProvider["tools"]["applyPatch"]>
>;
type LocalShellInput = InferToolInput<
  ReturnType<OpenAIProvider["tools"]["localShell"]>
>;
type ShellArgs = NonNullable<Parameters<OpenAIProvider["tools"]["shell"]>[0]>;
type ShellInput = InferToolInput<ReturnType<OpenAIProvider["tools"]["shell"]>>;
type TextEditorInput = InferToolInput<
  ReturnType<AnthropicProvider["tools"]["textEditor_20250728"]>
>;

// The bash factories are overloaded on their output, which hides the input from InferToolInput.
interface AnthropicBashInput {
  command?: string;
  restart?: boolean;
}

interface StandInContext {
  toolName: string;
  command: unknown;
  sandboxTools: ToolSet;
  fileContext: SandboxToolContext;
}

interface SandboxToolCall {
  toolName: SandboxToolName;
  input: Record<string, unknown>;
}

// Methods, so a stand-in typed by its provider's input fits the map: the AI SDK checks the
// model's input against that provider schema before execute.
export interface SandboxStandIn<Input = unknown> {
  // Policy, approval and denyTools judge a call as this Broods tool call, which is what runs.
  toSandboxCall(input: Input): SandboxToolCall;
  execute(input: Input, options: ExecutionOptions): Promise<unknown>;
  // Broods tools it replaces, so the model never sees two tools for one job.
  replaces: readonly SandboxToolName[];
  runsAs: readonly SandboxToolName[];
}

// Flagged client-executed by its factory, but the provider runs it.
export function runsOnProvider(
  id: string,
  args: Record<string, unknown>,
): boolean {
  if (id === "openrouter.web_search") return true;
  if (id === "openai.tool_search") return args.execution !== "client";

  return id === "openai.shell" && !isLocalShell(args);
}

export function sandboxStandIn(
  id: string,
  context: StandInContext,
): SandboxStandIn {
  const standIn = standInFor(id, context);
  if (!standIn) {
    throw new Error(
      `config.tools.${context.toolName} (${id}) runs in the caller's code, and Broods has no sandbox tool for it. ` +
        `Supported: Anthropic bash and text editor, OpenAI shell, local shell, apply patch and custom tools. ` +
        `Connect an MCP server for anything else.`,
    );
  }
  for (const name of standIn.runsAs) {
    if (!context.sandboxTools[name]) {
      throw new Error(
        `config.tools.${context.toolName} (${id}) runs as ${name}, which needs ` +
          (name === "bash"
            ? "a sandbox in config.sandboxes"
            : "a writable workspace in config.workspaces"),
      );
    }
  }

  return standIn;
}

function anthropicBash(
  context: StandInContext,
): SandboxStandIn<AnthropicBashInput> {
  const toSandboxCall = (input: AnthropicBashInput): SandboxToolCall =>
    bashCall(input.command ?? "");
  const run = runCall(context, toSandboxCall);

  return {
    replaces: ["bash"],
    runsAs: ["bash"],
    toSandboxCall: toSandboxCall,
    // Every Broods bash call starts a fresh shell, so a restart has nothing to reset.
    execute: async (input, options): Promise<unknown> =>
      input.restart === true ? "Shell restarted." : await run(input, options),
  };
}

function applyPatch(context: StandInContext): SandboxStandIn<ApplyPatchInput> {
  return {
    replaces: ["edit", "write"],
    runsAs: ["edit", "write"],
    toSandboxCall: (input): SandboxToolCall => ({
      toolName: "write",
      input: { file_path: input.operation.path },
    }),
    execute: async (input): Promise<unknown> => {
      const ws = resolveWorkspace(context.fileContext.workspaces);
      if (!ws?.sandbox) {
        return { status: "failed", output: "Error: workspace is read-only" };
      }
      const result = await runSandbox(
        ws.sandbox,
        ws.namespace,
        applyPatchScript(input.operation),
        {
          onSandboxCpu: context.fileContext.onSandboxCpu,
          metadata: sandboxRunMetadata(context.fileContext, ws),
        },
      );

      return result.ok && result.exitCode === 0
        ? { status: "completed", output: result.stdout.trim() }
        : {
            status: "failed",
            output: `${result.stderr}${result.stdout}`.trim(),
          };
    },
  };
}

function bashCall(command: string): SandboxToolCall {
  return { toolName: "bash", input: { command: command } };
}

async function callTool(
  context: StandInContext,
  call: SandboxToolCall,
  options: ExecutionOptions,
): Promise<unknown> {
  const execute = context.sandboxTools[call.toolName]?.execute;
  if (!execute) throw new Error(`the ${call.toolName} tool is not available`);

  return await execute(call.input, options);
}

// The model's text goes to the configured command on stdin, never into the command line.
function customTool(context: StandInContext): SandboxStandIn<string> {
  const command = configString(context.command);
  if (!command) {
    throw new Error(
      `config.tools.${context.toolName} is an OpenAI custom tool, so it needs \`command\`: ` +
        `the sandbox command that reads the model's text on stdin`,
    );
  }
  const toSandboxCall = (input: string): SandboxToolCall =>
    bashCall(`printf '%s' ${shellQuote(input)} | ${command}`);

  return {
    replaces: [],
    runsAs: ["bash"],
    toSandboxCall: toSandboxCall,
    execute: runCall(context, toSandboxCall),
  };
}

function exitCodeOf(output: string): number {
  if (output.endsWith("[command failed]")) return 1;

  return Number(/\[exit code (\d+)\]$/.exec(output)?.[1] ?? 0);
}

function isLocalShell(args: Record<string, unknown>): boolean {
  const type = (args as ShellArgs).environment?.type;

  return type === undefined || type === "local";
}

function localShell(context: StandInContext): SandboxStandIn<LocalShellInput> {
  const toSandboxCall = (input: LocalShellInput): SandboxToolCall => {
    const { command, workingDirectory, env } = input.action;
    const assignments = Object.entries(env ?? {}).map(
      ([name, value]): string => `${name}=${shellQuote(value)}`,
    );
    const line = [...assignments, ...command.map(shellQuote)].join(" ");

    return bashCall(
      workingDirectory ? `cd ${shellQuote(workingDirectory)} && ${line}` : line,
    );
  };
  const run = runCall(context, toSandboxCall);

  return {
    replaces: ["bash"],
    runsAs: ["bash"],
    toSandboxCall: toSandboxCall,
    execute: async (input, options): Promise<unknown> => ({
      output: String(await run(input, options)),
    }),
  };
}

function openaiShell(context: StandInContext): SandboxStandIn<ShellInput> {
  return {
    replaces: ["bash"],
    runsAs: ["bash"],
    toSandboxCall: (input): SandboxToolCall =>
      bashCall(input.action.commands.join("\n")),
    execute: async (input, options): Promise<unknown> => {
      const output = [];
      for (const command of input.action.commands) {
        try {
          const text = String(
            await callTool(context, bashCall(command), options),
          );
          output.push({
            stdout: text,
            stderr: "",
            outcome: { type: "exit", exitCode: exitCodeOf(text) },
          });
        } catch (cause) {
          const message = toErrorMessage(cause);
          output.push({
            stdout: "",
            stderr: message,
            outcome: message.includes("[timed out")
              ? { type: "timeout" }
              : { type: "exit", exitCode: 1 },
          });
        }
      }

      return { output: output };
    },
  };
}

function runCall<Input>(
  context: StandInContext,
  toSandboxCall: (input: Input) => SandboxToolCall,
): SandboxStandIn<Input>["execute"] {
  return async (input, options): Promise<unknown> =>
    await callTool(context, toSandboxCall(input), options);
}

function standInFor(
  id: string,
  context: StandInContext,
): SandboxStandIn | undefined {
  if (id === "anthropic.bash_20241022" || id === "anthropic.bash_20250124") {
    return anthropicBash(context);
  }
  if (id.startsWith("anthropic.text_editor_")) return textEditor(context);
  if (id === "openai.apply_patch") return applyPatch(context);
  if (id === "openai.custom") return customTool(context);
  if (id === "openai.local_shell") return localShell(context);
  if (id === "openai.shell") return openaiShell(context);

  return undefined;
}

function textEditor(context: StandInContext): SandboxStandIn<TextEditorInput> {
  const toSandboxCall = (editor: TextEditorInput): SandboxToolCall => {
    const path = editor.path;
    if (editor.command === "view") {
      const [start, end] = editor.view_range ?? [];
      return {
        toolName: "read",
        input: {
          file_path: path,
          ...(start !== undefined ? { offset: start } : {}),
          ...(start !== undefined && end !== undefined && end >= start
            ? { limit: end - start + 1 }
            : {}),
        },
      };
    }
    if (editor.command === "create") {
      return {
        toolName: "write",
        input: { file_path: path, content: editor.file_text ?? "" },
      };
    }

    return {
      toolName: "edit",
      input: {
        file_path: path,
        old_string: editor.old_str ?? "",
        new_string: editor.new_str ?? "",
      },
    };
  };
  const run = runCall(context, toSandboxCall);

  return {
    replaces: ["edit", "read", "write"],
    runsAs: ["edit", "read", "write"],
    toSandboxCall: toSandboxCall,
    execute: async (input, options): Promise<unknown> => {
      const { command } = input;
      if (!TEXT_EDITOR_COMMANDS.has(command)) {
        throw new Error(
          `Error: ${command} is not supported here; use str_replace or create`,
        );
      }

      return await run(input, options);
    },
  };
}
