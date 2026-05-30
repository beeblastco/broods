/**
 * S3-backed bash workspace tool for the harness agent.
 * Keep model-facing command orchestration here.
 */

import { jsonSchema, tool, type JSONSchema7, type Tool, type ToolSet } from "ai";
import { workspaceSandboxLimits } from "../../_shared/sandbox.ts";
import { createWorkspaceSandboxExecutor } from "../sandbox/index.ts";
import type { WorkspaceSandboxConfig, WorkspaceSandboxProvider, WorkspaceSandboxRuntime } from "../sandbox/types.ts";
import type { WorkspaceBinding } from "../../_shared/workspaces.ts";
import {
  assertExecutableExtension,
  assertSafeExecutionArgs,
  boundedInteger,
  formatSandboxResult,
  parseExecutionCommand,
  toScopedPath,
  type FilesystemInput,
} from "./filesystem-utils.ts";
import type { ToolContext } from "./index.ts";
import { logInfo } from "../../_shared/log.ts";

type FilesystemToolResult = Awaited<ReturnType<NonNullable<Tool<FilesystemInput, unknown>["toModelOutput"]>>>;

const errorText = (value: string): FilesystemToolResult => ({ type: "error-text", value });
const text = (value: string): FilesystemToolResult => ({ type: "text", value });
const json = (value: ReturnType<typeof formatSandboxResult>): FilesystemToolResult => ({ type: "json", value });

function filesystemInputSchema(workspaces: WorkspaceBinding[], provider: WorkspaceSandboxProvider): JSONSchema7 {
  const properties: Record<string, JSONSchema7> = {
    shell: {
      type: "string",
      description: shellInputDescription(provider),
    },
  };

  if (workspaces.length > 1) {
    properties.workspace = {
      type: "string",
      enum: workspaces.map((workspace) => workspace.id),
      description: "Named workspace to run the command in. Omit to use the default workspace.",
    };
  }

  return {
    type: "object",
    properties,
    required: ["shell"],
    additionalProperties: false,
  };
}

export default function filesystemTool(context: ToolContext): ToolSet {
  const workspaces = context.workspaceBindings?.length
    ? context.workspaceBindings
    : [{ id: "default", namespace: context.filesystemNamespace, isDefault: true }];
  const sandboxConfig = context.config as WorkspaceSandboxConfig;
  const provider = sandboxConfig.provider ?? "lambda";

  return {
    bash: tool({
      description: workspaceToolDescription(workspaces),
      inputSchema: jsonSchema(filesystemInputSchema(workspaces, provider)),
      execute(input) {
        const workspace = selectWorkspace(workspaces, (input as FilesystemInput).workspace);
        if (!workspace) {
          return errorText(`Error: unknown workspace ${(input as FilesystemInput).workspace}`);
        }
        return executeFilesystemShell((input as FilesystemInput).shell, workspace.namespace, sandboxConfig);
      },
    }),
  };
}

function workspaceToolDescription(workspaces: WorkspaceBinding[]): string {
  const base = "Bash shell on a Linux sandbox rooted at /. Use it to read/write persistent files and run scripts and programs.";
  if (workspaces.length === 1) {
    return base;
  }

  const workspaceList = workspaces
    .map((workspace) => `${workspace.id}${workspace.isDefault ? " (default)" : ""}`)
    .join(", ");
  return `${base} Available workspaces: ${workspaceList}.`;
}

// The model performs best when the sandbox looks like an ordinary Linux machine,
// so the description stays generic and short — strong models already know bash,
// and every niche caveat measurably degrades them (matches Anthropic/OpenAI tool
// guidance: state only what is genuinely non-obvious about this environment).
// The one non-obvious fact true for every provider is that each call is a fresh
// shell (files persist, shell state does not), so it lives in the generic text.
// Lambda is the only restricted runtime (emulated shell + split Python runtime),
// so its extra limits are appended only for that provider; e2b/daytona run a real
// VM and get the clean prompt unchanged.
function shellInputDescription(provider: WorkspaceSandboxProvider): string {
  const generic = `Bash command to run in a Linux sandbox rooted at the workspace. Run \`pwd\` first to see the working directory.

Use normal bash: pipes, redirects, globs, variables, loops, and the usual file/text tools. Run programs directly, e.g. \`python3 script.py\` or \`node app.js\`. Heredocs work: \`cat <<'EOF' > file ... EOF\`. stdout and stderr are returned together, and very large output is truncated.

Files you write to the workspace persist across calls, but shell state does not: the working directory, environment variables, and background processes reset every call, so keep the steps of a task in one command. Pre-configured environment variables are injected automatically.`;

  if (provider !== "lambda") {
    return generic;
  }

  return `${generic}

This sandbox has a few extra limits:
- The shell is an emulated bash. Common tools are available (pwd, ls, cat, sed, awk, grep, rg, find, jq, tar, gzip, cp, mv, rm, mkdir, touch); some system binaries are not.
- node: run a file only — \`node <file.js|file.ts>\`; inline flags like \`node -e\` are not supported.
- python: prefer running it as a standalone command — \`python3 <name>.py\` or \`python <name>.py\` — with no other commands in the same call, so it executes on the dedicated native CPython runtime (full stdlib). Python is not available inside a larger shell command (e.g. after a heredoc); write the file in one call, then run it on its own in the next.`;
}

function selectWorkspace(workspaces: WorkspaceBinding[], requestedWorkspace: string | undefined): WorkspaceBinding | null {
  if (!requestedWorkspace) {
    return workspaces.find((workspace) => workspace.isDefault) ?? workspaces[0]!;
  }

  const workspace = workspaces.find((entry) => entry.id === requestedWorkspace);
  if (!workspace) {
    return null;
  }
  return workspace;
}

async function executeFilesystemShell(
  shell: string,
  namespace: string,
  sandboxConfig: WorkspaceSandboxConfig,
): Promise<FilesystemToolResult> {
  const command = shell.trim();
  if (!command) {
    return errorText("Error: shell command is required");
  }

  logInfo("bash tool command", { namespace, command });

  // On Lambda the shell is emulated (just-bash) and Python files run best on the
  // dedicated SandboxPython runtime, so a standalone `python <file>` is routed
  // there. Other providers are real machines with native runtimes on PATH, so the
  // whole command goes straight to their shell.
  if ((sandboxConfig.provider ?? "lambda") === "lambda") {
    try {
      const execution = parseExecutionCommand(command);
      if (execution?.runtime === "python") {
        return json(await executeWorkspaceFile(execution, namespace, sandboxConfig));
      }
    } catch (cause) {
      return errorText(cause instanceof Error ? cause.message : String(cause));
    }
  }

  try {
    return text(await executeWorkspaceShell(command, namespace, sandboxConfig));
  } catch (cause) {
    return errorText(cause instanceof Error ? cause.message : String(cause));
  }
}

async function executeWorkspaceShell(
  shell: string,
  namespace: string,
  sandboxConfig: WorkspaceSandboxConfig,
): Promise<string> {
  const executor = createWorkspaceSandboxExecutor(sandboxConfig);
  if (!executor.runShell) {
    throw new Error("Error: workspace shell execution is only supported by the lambda sandbox provider");
  }

  const limits = workspaceSandboxLimits();
  const result = await executor.runShell({
    namespace,
    shell,
    workspaceRoot: workspaceRootFor(sandboxConfig),
    timeoutSeconds: boundedInteger(
      sandboxConfig.timeout,
      limits.defaultTimeoutSeconds,
      limits.maxTimeoutSeconds,
    ),
    outputLimitBytes: boundedInteger(
      sandboxConfig.outputLimitBytes,
      limits.defaultOutputLimitBytes,
      limits.maxOutputLimitBytes,
    ),
  });

  return `${result.stdout}${result.stderr}`;
}

async function executeWorkspaceFile(
  execution: {
    runtime: WorkspaceSandboxRuntime;
    executable: "node" | "python" | "python3";
    path: string;
    args: string[];
  },
  namespace: string,
  sandboxConfig: WorkspaceSandboxConfig,
): Promise<ReturnType<typeof formatSandboxResult>> {
  const normalizedPath = toScopedPath(execution.path, namespace);
  assertExecutableExtension(normalizedPath, execution.runtime);
  assertSafeExecutionArgs(execution.args);

  const executor = createWorkspaceSandboxExecutor(sandboxConfig);
  const limits = workspaceSandboxLimits();
  const result = await executor.runFile({
    runtime: execution.runtime,
    namespace: namespace,
    entryPath: normalizedPath,
    args: execution.args,
    workspaceRoot: workspaceRootFor(sandboxConfig),
    timeoutSeconds: boundedInteger(
      sandboxConfig.timeout,
      limits.defaultTimeoutSeconds,
      limits.maxTimeoutSeconds,
    ),
    outputLimitBytes: boundedInteger(
      sandboxConfig.outputLimitBytes,
      limits.defaultOutputLimitBytes,
      limits.maxOutputLimitBytes,
    ),
  });

  return formatSandboxResult(result);
}

function workspaceRootFor(sandboxConfig: WorkspaceSandboxConfig): string {
  const options = sandboxConfig.options && typeof sandboxConfig.options === "object" && !Array.isArray(sandboxConfig.options)
    ? sandboxConfig.options
    : {};
  return typeof options.workspaceRoot === "string" && options.workspaceRoot.trim()
    ? options.workspaceRoot.trim()
    : "/mnt/workspaces";
}
