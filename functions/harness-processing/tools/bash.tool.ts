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
  outsideWorkspaceCommand,
  resolveWorkspace,
  runtimeDescription,
  runSandbox,
  runSandboxBackground,
  toolError,
  toolText,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";
import {
  createPendingAsyncToolResult,
  markAsyncToolResultFailed,
  sealExternalAsyncToolDispatchGroup,
} from "../async-tool-result.ts";
import { generateJobId } from "../sandbox/jobs.ts";
import { getHarnessPublicUrl } from "../self-url.ts";
import type { ResolvedWorkspace } from "../../_shared/workspaces.ts";
import type { SandboxExecutorConfig, SandboxJobCallback } from "../sandbox/types.ts";
import { logInfo } from "../../_shared/log.ts";

interface BashInput {
  command: string;
  workspace?: string;
  background?: boolean;
}

// Background jobs need a persistent workspace sandbox (to outlive the request)
// and a parent session to track the job as an AsyncToolResult.
function backgroundAvailable(context: SandboxToolContext): boolean {
  return Boolean(context.background) && context.workspaces.some((workspace) => workspace.sandbox?.persistent === true);
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
      ...(backgroundAvailable(context)
        ? {
            background: {
              type: "boolean",
              description:
                "Run the command as a detached background job in the reserved sandbox and return immediately with a resultId. Use for long-running tasks (builds, installs, training). The result is delivered back into the conversation automatically when the job finishes; you can also check progress meanwhile with async_status.",
            } as JSONSchema7,
          }
        : {}),
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
- Each command starts in the current workspace directory; use relative paths.
- Files you write to the workspace persist across calls, but shell state does not: the working directory, environment variables, and background processes reset every call — chain dependent steps with && in a single command.${
    backgroundAvailable(context)
      ? `
- This workspace is reserved (persistent): packages installed under $HOME (e.g. a uv/venv or npm prefix) and files survive across calls. Set background:true for long-running commands; the result is delivered back automatically when it finishes, and you can check on it with async_status.`
      : ""
  }`;
}

async function dispatchBackground(
  context: SandboxToolContext,
  ws: ResolvedWorkspace | undefined,
  _sandbox: SandboxExecutorConfig,
  command: string,
  toolCallId: string,
) {
  if (!ws || ws.sandbox?.persistent !== true) {
    return toolError("Error: background jobs require a persistent workspace sandbox");
  }
  if (!context.background) {
    return toolError("Error: background jobs are not available in this context");
  }

  const resultId = `async_tool_${crypto.randomUUID()}`;
  const completionToken = crypto.randomUUID();
  const jobId = generateJobId();
  // Per-job dispatch group keyed off the turn event so the job's completion
  // resumes the conversation on its own, independent of the turn's other tools.
  const parentEventId = `${context.background.eventId}:async-bg:${resultId}`;
  const baseUrl = await getHarnessPublicUrl();
  const callback: SandboxJobCallback | undefined = baseUrl
    ? { url: `${baseUrl}/sandbox-jobs/${encodeURIComponent(resultId)}/complete`, token: completionToken }
    : undefined;

  // Create + seal the tracking row BEFORE launching so a fast job's callback can
  // never arrive before the row exists.
  await createPendingAsyncToolResult({
    resultId,
    parentEventId,
    conversationKey: context.background.conversationKey,
    toolName: "bash",
    toolCallId,
    input: { kind: "sandbox_job", namespace: ws.namespace, jobId, command },
    // Push the result back to the originating channel/WebSocket when known;
    // otherwise it settles for status polling only.
    delivery: context.background.delivery ?? { kind: "async" },
    completionToken,
  });
  await sealExternalAsyncToolDispatchGroup(parentEventId);

  try {
    await runSandboxBackground(ws.sandbox, ws.namespace, command, {
      jobId,
      ...(callback ? { callback } : {}),
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    await markAsyncToolResultFailed({ resultId, error }).catch(() => {});
    return toolError(`Error: failed to start background job: ${error}`);
  }

  logInfo("bash background job started", { namespace: ws.namespace, jobId, resultId, delivers: Boolean(callback) });
  const delivery = callback
    ? "Its result will be delivered back into this conversation when it finishes."
    : "Poll async_status with this resultId to retrieve the result (automatic delivery is unavailable in this environment).";
  return toolText(
    `Started background job ${jobId} (resultId: ${resultId}). ${delivery} ` +
      `You can also use async_status to check status, tail logs (action "logs"), or stop it (action "stop").`,
  );
}

export default function bashTool(context: SandboxToolContext): ToolSet {
  return {
    bash: tool({
      description: description(context),
      inputSchema: jsonSchema(inputSchema(context)),
      needsApproval: (input) => bashNeedsApproval(context, (input as BashInput).workspace),
      async execute(input, options) {
        const { command, workspace, background } = input as BashInput;
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
          const outsideWorkspace = ws ? outsideWorkspaceCommand(trimmed) : undefined;
          if (outsideWorkspace) {
            return toolError(outsideWorkspace);
          }
          const disallowed = disallowedRuntimeCommand(sandbox, trimmed);
          if (disallowed) {
            return toolError(disallowed);
          }
          if (background === true) {
            return await dispatchBackground(context, ws, sandbox, trimmed, options.toolCallId);
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
