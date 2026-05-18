/**
 * S3-backed persistent filesystem tool for the harness agent.
 * Keep model-facing command orchestration here.
 */

import { jsonSchema, tool, type JSONSchema7, type Tool, type ToolSet } from "ai";
import { workspaceSandboxLimits } from "../../_shared/sandbox.ts";
import { createWorkspaceSandboxExecutor } from "../sandbox/index.ts";
import type { WorkspaceSandboxConfig, WorkspaceSandboxRuntime } from "../sandbox/types.ts";
import {
  appendToFilesystemFile,
  assertExecutableExtension,
  assertSafeExecutionArgs,
  boundedInteger,
  checkPathExists,
  createFilesystemDirectory,
  deleteFilesystemPath,
  formatSandboxResult,
  getVisibleRoot,
  listFilesystemEntries,
  parseExecutionCommand,
  parseHeredocCommand,
  parseLsPath,
  readFilesystemRange,
  readFilesystemRaw,
  renameFilesystemPath,
  stripQuotes,
  toScopedPath,
  toVisiblePath,
  touchFilesystemFile,
  writeFilesystemFile,
  type FilesystemInput,
} from "./filesystem-utils.ts";
import type { ToolContext } from "./index.ts";

type FilesystemToolResult = Awaited<ReturnType<NonNullable<Tool<FilesystemInput, unknown>["toModelOutput"]>>>;

const errorText = (value: string): FilesystemToolResult => ({ type: "error-text", value });
const text = (value: string): FilesystemToolResult => ({ type: "text", value });
const json = (value: ReturnType<typeof formatSandboxResult>): FilesystemToolResult => ({ type: "json", value });

const filesystemInputSchema: JSONSchema7 = {
  type: "object",
  properties: {
    shell: {
      type: "string",
      description: `Terminal command to run against the virtual filesystem rooted at /.

Prefer shell mode. Supported commands:
- pwd
- ls [path]
- cat <path>
- sed -n 'start,endp' <path>
- mkdir -p <dir>
- touch <file>
- rm -r <path>
- mv <old> <new>
- node <file.js|file.ts> --args
- python3 <file.py> --args
- cat <<'EOF' > <path> ... EOF
- cat <<'EOF' >> <path> ... EOF

Note:
- You cannot set the environment as each execution is stateless. User should already configured the environment variables in the sandbox config, ask user if they haven't already did that or if executed code return errors. The sandbox will auto injected pre-configured environment variables into the runtime`,
    },
  },
  required: ["shell"],
  additionalProperties: false,
};

export default function filesystemTool(context: ToolContext): ToolSet {
  const namespace = context.filesystemNamespace;
  const sandboxConfig = context.config as WorkspaceSandboxConfig;

  return {
    filesystem: tool({
      description: "Terminal-style filesystem rooted at /. Use shell commands to read and write persistent files.",
      inputSchema: jsonSchema(filesystemInputSchema),
      execute(input) {
        return executeFilesystemShell((input as FilesystemInput).shell, namespace, sandboxConfig);
      },
    }),
  };
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

  if (command === "pwd") {
    return text(getVisibleRoot(namespace));
  }

  const heredoc = parseHeredocCommand(command);
  if (heredoc) {
    try {
      return text(await writeFilesystemFile({
        name: heredoc.path,
        fileText: heredoc.append
          ? await appendToFilesystemFile(heredoc.path, heredoc.body, namespace)
          : heredoc.body,
        namespace,
      }));
    } catch (cause) {
      return errorText(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (command.startsWith("ls")) {
    return text(await listFilesystemEntries(parseLsPath(command), namespace));
  }

  const sedMatch = command.match(/^sed\s+-n\s+['"](\d+),(\d+)p['"]\s+(.+)$/s);
  if (sedMatch) {
    return text(await readFilesystemRange(stripQuotes(sedMatch[3]!), Number(sedMatch[1]), Number(sedMatch[2]), namespace));
  }

  const catMatch = command.match(/^cat\s+(.+)$/s);
  if (catMatch) {
    return text(await readFilesystemRaw(stripQuotes(catMatch[1]!), namespace));
  }

  const mkdirMatch = command.match(/^mkdir\s+-p\s+(.+)$/s);
  if (mkdirMatch) {
    return text(await createFilesystemDirectory(stripQuotes(mkdirMatch[1]!), namespace));
  }

  const touchMatch = command.match(/^touch\s+(.+)$/s);
  if (touchMatch) {
    return text(await touchFilesystemFile(stripQuotes(touchMatch[1]!), namespace));
  }

  const rmMatch = command.match(/^rm(?:\s+-[rf]+\s+|\s+-[fr]+\s+|\s+)(.+)$/s);
  if (rmMatch) {
    return text(await deleteFilesystemPath({ name: stripQuotes(rmMatch[1]!), namespace: namespace }));
  }

  const mvMatch = command.match(/^mv\s+(\S+)\s+(\S+)$/);
  if (mvMatch) {
    return text(await renameFilesystemPath({ oldName: stripQuotes(mvMatch[1]!), newName: stripQuotes(mvMatch[2]!), namespace: namespace }));
  }

  try {
    const execution = parseExecutionCommand(command);
    if (execution) {
      return json(await executeWorkspaceFile(execution, namespace, sandboxConfig));
    }
  } catch (cause) {
    return errorText(cause instanceof Error ? cause.message : String(cause));
  }

  return errorText(`Unsupported shell command.
Supported commands:
- pwd
- ls [path]
- cat <path>
- sed -n 'start,endp' <path>
- mkdir -p <dir>
- touch <file>
- rm -r <path>
- mv <old> <new>
- node <file.js|file.ts>
- python3 <file.py>
- cat <<'EOF' > <path> ... EOF
- cat <<'EOF' >> <path> ... EOF`);
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
  if (sandboxConfig.enabled !== true) {
    throw new Error("Error: workspace sandbox execution is disabled");
  }

  const normalizedPath = toScopedPath(execution.path, namespace);
  assertExecutableExtension(normalizedPath, execution.runtime);
  assertSafeExecutionArgs(execution.args);

  const state = await checkPathExists(namespace, normalizedPath);
  if (!state.exists) {
    throw new Error(`${execution.executable}: ${toVisiblePath(normalizedPath, namespace)}: No such file or directory`);
  }
  if (state.isDirectory) {
    throw new Error(`${execution.executable}: ${toVisiblePath(normalizedPath, namespace)}: Is a directory`);
  }

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
