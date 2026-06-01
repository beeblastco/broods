/**
 * Bash tool — runs a shell command in the sandbox (real bash + python3 + node).
 * Stateless when no workspace is attached (ephemeral container per call);
 * workspace-backed when one is, with files persisting on the mount. Each
 * workspace runs on its own effective sandbox and inherits its permissionMode.
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import {
  bashNeedsApproval,
  disallowedRuntimeCommand,
  formatRunText,
  resolveWorkspace,
  runtimeDescription,
  runSandbox,
  toolError,
  toolText,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";
import { logInfo } from "../../_shared/log.ts";

interface BashInput {
  command: string;
  workspace?: string;
}

function inputSchema(context: SandboxToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);
  return {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to run.",
      },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["command"],
    additionalProperties: false,
  };
}

function description(context: SandboxToolContext): string {
  if (context.workspaces.length === 0) {
    const runtimes = runtimeDescription(context.statelessSandbox);
    return `Executes a bash command in an ephemeral Linux sandbox (bash, python3, and node on PATH).

Usage notes:
- ${runtimes}
- Use proper quoting for paths or arguments containing spaces (e.g. cd "path with spaces").
- Run programs directly, e.g. \`python3 script.py\` or \`node app.js\`. stdout and stderr are returned together; very large output is truncated.
- The sandbox is stateless: each call runs in a fresh container with no persistent storage. Files do NOT persist across calls, and shell state (working directory, environment variables, background processes) resets every call — keep the whole task in a single command, chaining steps with && or ;.`;
  }

  return `Executes a bash command on the attached workspace in a Linux sandbox (bash, python3, and node on PATH).

Usage notes:
- The selected workspace's sandbox may restrict runtimes; commands using disallowed runtimes are rejected before execution.
- Use proper quoting for paths or arguments containing spaces (e.g. cd "path with spaces").
- IMPORTANT: prefer the dedicated \`read\`, \`write\`, \`edit\`, \`glob\`, and \`grep\` tools over their bash equivalents (cat/sed/find/grep) — they are faster, safer, and return structured results.
- Run programs directly, e.g. \`python3 script.py\` or \`node app.js\`. stdout and stderr are returned together; very large output is truncated.
- Files you write to the workspace persist across calls, but shell state does not: the working directory, environment variables, and background processes reset every call — chain dependent steps with && in a single command.`;
}

export default function bashTool(context: SandboxToolContext): ToolSet {
  return {
    bash: tool({
      description: description(context),
      inputSchema: jsonSchema(inputSchema(context)),
      needsApproval: (input) => bashNeedsApproval(context, (input as BashInput).workspace),
      async execute(input) {
        const { command, workspace } = input as BashInput;
        const trimmed = (command ?? "").trim();
        if (!trimmed) {
          return toolError("Error: command is required");
        }
        try {
          const ws = context.workspaces.length > 0
            ? resolveWorkspace(context.workspaces, workspace)
            : undefined;
          const sandbox = ws?.sandbox ?? context.statelessSandbox;
          if (!sandbox) {
            return toolError("Error: no sandbox available for this command");
          }
          const disallowed = disallowedRuntimeCommand(sandbox, trimmed);
          if (disallowed) {
            return toolError(disallowed);
          }
          logInfo("bash tool command", { namespace: ws?.namespace, commandLength: trimmed.length });
          return toolText(formatRunText(await runSandbox(sandbox, ws?.namespace, trimmed)));
        } catch (cause) {
          return toolError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    }),
  };
}
