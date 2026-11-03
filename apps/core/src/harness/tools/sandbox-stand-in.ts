// Client-executed provider tools (the provider defines the schema, the caller runs it), run on
// the agent's sandbox through the Broods tool each one stands for.

import type { AnthropicProvider } from "@ai-sdk/anthropic";
import type { OpenAIProvider } from "@ai-sdk/openai";
import type { InferToolInput, ToolSet } from "ai";
import { shellQuote } from "../sandbox/utils.ts";
import { applyPatchScript } from "./apply-patch.ts";
import {
  resolveWorkspace,
  runSandbox,
  sandboxRunMetadata,
  type SandboxToolContext,
} from "./filesystem-utils.ts";

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
  args: Record<string, unknown>;
  command: unknown;
  sandboxTools: ToolSet;
  fileContext: SandboxToolContext;
}

export interface SandboxToolCall {
  toolName: SandboxToolName;
  input: Record<string, unknown>;
}

export interface SandboxStandIn {
  // Policy, approval and denyTools treat a call as this Broods tool call.
  toSandboxCall: (input: unknown) => SandboxToolCall;
  execute: (input: unknown, options: ExecutionOptions) => Promise<unknown>;
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

function anthropicBash(context: StandInContext): SandboxStandIn {
  return {
    replaces: ["bash"],
    runsAs: ["bash"],
    toSandboxCall: (input): SandboxToolCall => ({
      toolName: "bash",
      input: { command: (input as AnthropicBashInput).command ?? "" },
    }),
    // Every Broods bash call starts a fresh shell, so a restart has nothing to reset.
    execute: async (input, options): Promise<unknown> => {
      const { command, restart } = input as AnthropicBashInput;
      if (restart === true) return "Shell restarted.";

      return await callTool(context, "bash", { command: command }, options);
    },
  };
}

function applyPatch(context: StandInContext): SandboxStandIn {
  return {
    replaces: ["edit", "write"],
    runsAs: ["edit", "write"],
    toSandboxCall: (input): SandboxToolCall => ({
      toolName: "write",
      input: { file_path: (input as ApplyPatchInput).operation.path },
    }),
    execute: async (input): Promise<unknown> => {
      const ws = resolveWorkspace(context.fileContext.workspaces);
      if (!ws?.sandbox) {
        return { status: "failed", output: "Error: workspace is read-only" };
      }
      const result = await runSandbox(
        ws.sandbox,
        ws.namespace,
        applyPatchScript((input as ApplyPatchInput).operation),
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

async function callTool(
  context: StandInContext,
  name: SandboxToolName,
  input: Record<string, unknown>,
  options: ExecutionOptions,
): Promise<unknown> {
  const execute = context.sandboxTools[name]?.execute;
  if (!execute) throw new Error(`the ${name} tool is not available`);

  return await execute(input, options);
}

// The model's text goes to the configured command on stdin, never into the command line.
function customTool(context: StandInContext): SandboxStandIn {
  const { command, toolName } = context;
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error(
      `config.tools.${toolName} is an OpenAI custom tool, so it needs \`command\`: ` +
        `the sandbox command that reads the model's text on stdin`,
    );
  }
  const commandFor = (input: unknown): string =>
    `printf '%s' ${shellQuote(String(input))} | ${command}`;

  return {
    replaces: [],
    runsAs: ["bash"],
    toSandboxCall: (input): SandboxToolCall => ({
      toolName: "bash",
      input: { command: commandFor(input) },
    }),
    execute: async (input, options): Promise<unknown> =>
      await callTool(context, "bash", { command: commandFor(input) }, options),
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

function localShell(context: StandInContext): SandboxStandIn {
  const commandFor = (input: unknown): string => {
    const { command, workingDirectory, env } = (input as LocalShellInput)
      .action;
    const assignments = Object.entries(env ?? {}).map(
      ([name, value]): string => `${name}=${shellQuote(value)}`,
    );
    const line = [...assignments, ...command.map(shellQuote)].join(" ");

    return workingDirectory
      ? `cd ${shellQuote(workingDirectory)} && ${line}`
      : line;
  };

  return {
    replaces: ["bash"],
    runsAs: ["bash"],
    toSandboxCall: (input): SandboxToolCall => ({
      toolName: "bash",
      input: { command: commandFor(input) },
    }),
    execute: async (input, options): Promise<unknown> => ({
      output: String(
        await callTool(
          context,
          "bash",
          { command: commandFor(input) },
          options,
        ),
      ),
    }),
  };
}

function openaiShell(context: StandInContext): SandboxStandIn {
  return {
    replaces: ["bash"],
    runsAs: ["bash"],
    toSandboxCall: (input): SandboxToolCall => ({
      toolName: "bash",
      input: { command: (input as ShellInput).action.commands.join("\n") },
    }),
    execute: async (input, options): Promise<unknown> => {
      const output = [];
      for (const command of (input as ShellInput).action.commands) {
        try {
          const text = String(
            await callTool(context, "bash", { command: command }, options),
          );
          output.push({
            stdout: text,
            stderr: "",
            outcome: { type: "exit", exitCode: exitCodeOf(text) },
          });
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
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

function textEditor(context: StandInContext): SandboxStandIn {
  return {
    replaces: ["edit", "read", "write"],
    runsAs: ["edit", "read", "write"],
    toSandboxCall: (input): SandboxToolCall => {
      const { command, path } = input as TextEditorInput;

      return {
        toolName:
          command === "view" ? "read" : command === "create" ? "write" : "edit",
        input: { file_path: path },
      };
    },
    execute: async (input, options): Promise<unknown> => {
      const editor = input as Omit<TextEditorInput, "command"> & {
        command: string;
      };
      const file = editor.path;
      if (editor.command === "view") {
        const [start, end] = editor.view_range ?? [];
        return await callTool(
          context,
          "read",
          {
            file_path: file,
            ...(start !== undefined ? { offset: start } : {}),
            ...(start !== undefined && end !== undefined && end >= start
              ? { limit: end - start + 1 }
              : {}),
          },
          options,
        );
      }
      if (editor.command === "create") {
        return await callTool(
          context,
          "write",
          { file_path: file, content: editor.file_text ?? "" },
          options,
        );
      }
      if (editor.command === "str_replace") {
        return await callTool(
          context,
          "edit",
          {
            file_path: file,
            old_string: editor.old_str ?? "",
            new_string: editor.new_str ?? "",
          },
          options,
        );
      }

      throw new Error(
        `Error: ${editor.command} is not supported here; use str_replace or create`,
      );
    },
  };
}
