/**
 * S3-backed bash workspace tool for the harness agent.
 * Keep model-facing command orchestration here.
 */

import { jsonSchema, tool, type JSONSchema7, type Tool, type ToolSet } from "ai";
import { workspaceSandboxLimits } from "../../_shared/sandbox.ts";
import { createWorkspaceSandboxExecutor } from "../sandbox/index.ts";
import type { WorkspaceSandboxConfig, WorkspaceSandboxRuntime } from "../sandbox/types.ts";
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

function filesystemInputSchema(workspaces: WorkspaceBinding[]): JSONSchema7 {
  const properties: Record<string, JSONSchema7> = {
    shell: {
      type: "string",
      description: `Bash command to run against the persistent workspace filesystem. You always need to run pwd to see your current filesystem.

Prefer shell mode. Supported commands:
- bash-like shell scripts, pipes, redirects, globs, variables, and loops
- common file/text commands such as pwd, ls, cat, sed, awk, grep, rg, find, jq, tar, gzip, cp, mv, rm, mkdir, touch
- node <file.js|file.ts> --args
- python3 <file.py> --args
- cat <<'EOF' > <path> ... EOF
- cat <<'EOF' >> <path> ... EOF

Note:
- Node inline flags such as node -e are not supported. Write a .js or .ts file first, then run node <file.js|file.ts>.
- You cannot set the environment as each execution is stateless. User should already configured the environment variables in the sandbox config, ask user if they haven't already did that or if executed code return errors. The sandbox will auto injected pre-configured environment variables into the runtime`,
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

  return {
    bash: tool({
      description: workspaceToolDescription(workspaces),
      inputSchema: jsonSchema(filesystemInputSchema(workspaces)),
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
  const base = "Bash-style workspace shell rooted at /. Use it to read/write persistent files and run scripts. Node must be run from a workspace .js or .ts file; inline node -e commands are not supported.";
  if (workspaces.length === 1) {
    return base;
  }

  const workspaceList = workspaces
    .map((workspace) => `${workspace.id}${workspace.isDefault ? " (default)" : ""}`)
    .join(", ");
  return `${base} Available workspaces: ${workspaceList}.`;
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

  try {
    const execution = parseExecutionCommand(command);
    if (execution?.runtime === "python") {
      return json(await executeWorkspaceFile(execution, namespace, sandboxConfig));
    }
  } catch (cause) {
    return errorText(cause instanceof Error ? cause.message : String(cause));
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
