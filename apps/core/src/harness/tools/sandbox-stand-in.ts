// Client-executed provider tools (the provider defines the schema, the caller runs it), run on
// the agent's sandbox through the Broods tool each one stands for.

import type { AnthropicProvider } from "@ai-sdk/anthropic";
import type { OpenAIProvider } from "@ai-sdk/openai";
import type { InferToolInput, ToolSet } from "ai";
import { toErrorMessage } from "../../shared/errors.ts";
import { configString, shellQuote } from "../sandbox/utils.ts";
import { fileOperationScript, type FileOperation } from "./file-operation.ts";
import {
  resolveWorkspace,
  runSandbox,
  sandboxParamChoices,
  sandboxRunMetadata,
  type SandboxToolContext,
} from "./filesystem-utils.ts";

const TEXT_EDITOR_COMMANDS = new Set([
  "create",
  "insert",
  "str_replace",
  "view",
]);

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
    if (offersTargetChoice(name, context.fileContext)) {
      throw new Error(
        `config.tools.${context.toolName} (${id}) has no input to pick a workspace or sandbox, ` +
          `and this agent has more than one for ${name}. Keep one, or use the Broods tools.`,
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
      toolName: input.operation.type === "update_file" ? "edit" : "write",
      input: { file_path: input.operation.path },
    }),
    execute: async (input): Promise<unknown> => {
      const { ok, output } = await runFileOperation(context, input.operation);

      return { status: ok ? "completed" : "failed", output: output };
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

// The model's text goes to the command on stdin as a quoted heredoc, so bash never parses it.
// The group keeps a command ending in `#`, `&` or a pipe from swallowing the heredoc.
function customTool(context: StandInContext): SandboxStandIn<string> {
  const command = configString(context.command);
  if (!command) {
    throw new Error(
      `config.tools.${context.toolName} is an OpenAI custom tool, so it needs \`command\`: ` +
        `the sandbox command that reads the model's text on stdin`,
    );
  }
  const toSandboxCall = (input: string): SandboxToolCall => {
    let marker = "BROODS_INPUT";
    while (input.split("\n").includes(marker)) marker += "_";

    return bashCall(`{ ${command}\n} <<'${marker}'\n${input}\n${marker}`);
  };

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

// Older editors send the inserted text as new_str.
function insertText(editor: TextEditorInput): string {
  return editor.insert_text ?? editor.new_str ?? "";
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

// Broods bash and the file tools take a target only when the agent has more than one.
function offersTargetChoice(
  name: SandboxToolName,
  context: SandboxToolContext,
): boolean {
  if (context.workspaces.length > 1) return true;

  return name === "bash" && sandboxParamChoices(context).length > 0;
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

async function runFileOperation(
  context: StandInContext,
  operation: FileOperation,
): Promise<{ ok: boolean; output: string }> {
  const ws = resolveWorkspace(context.fileContext.workspaces);
  if (!ws?.sandbox)
    return { ok: false, output: "Error: workspace is read-only" };
  const result = await runSandbox(
    ws.sandbox,
    ws.namespace,
    fileOperationScript(operation),
    {
      onSandboxCpu: context.fileContext.onSandboxCpu,
      metadata: sandboxRunMetadata(context.fileContext, ws),
    },
  );
  const ok = result.ok && result.exitCode === 0;

  return {
    ok: ok,
    output: (ok ? result.stdout : `${result.stderr}${result.stdout}`).trim(),
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
    if (editor.command === "insert") {
      return {
        toolName: "edit",
        input: {
          file_path: path,
          insert_line: editor.insert_line ?? 0,
          new_string: insertText(editor),
        },
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
          `Error: ${command} is not supported here; use view, create, str_replace or insert`,
        );
      }
      if (command !== "insert") return await run(input, options);
      const { ok, output } = await runFileOperation(context, {
        type: "insert",
        path: input.path,
        line: input.insert_line ?? 0,
        text: insertText(input),
      });
      if (!ok) throw new Error(output);

      return output;
    },
  };
}
