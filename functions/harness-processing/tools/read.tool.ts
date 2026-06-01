/**
 * Read tool — reads a file from the workspace, returning numbered lines
 * (Claude-Code-style). Sandbox-backed workspaces read through the mount; a
 * read-only workspace (no sandbox) reads directly from S3.
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import {
  resolveWorkspace,
  runSandbox,
  s3ReadNumbered,
  shellQuote,
  toWorkspaceRelative,
  toolError,
  toolText,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  workspace?: string;
}

const DEFAULT_LIMIT = 2000;

function inputSchema(context: SandboxToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);
  return {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file, relative to the workspace root." },
      offset: { type: "integer", description: "1-based line number to start reading from." },
      limit: { type: "integer", description: `Maximum number of lines to read (default ${DEFAULT_LIMIT}).` },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["file_path"],
    additionalProperties: false,
  };
}

export default function readTool(context: SandboxToolContext): ToolSet {
  return {
    read: tool({
      description: `Reads a file from the workspace, returning its contents with line numbers (cat -n style).

Usage notes:
- file_path is relative to the workspace root.
- Reads up to ${DEFAULT_LIMIT} lines from the start by default; use offset and limit to page through large files.
- Lines are returned as \`<line_number>\\t<content>\`.
- Prefer this over \`bash cat\` for reading files.`,
      inputSchema: jsonSchema(inputSchema(context)),
      async execute(input) {
        const { file_path, offset, limit, workspace } = input as ReadInput;
        try {
          const ws = resolveWorkspace(context.workspaces, workspace);
          if (!ws) {
            return toolError("Error: no workspace attached");
          }
          const rel = toWorkspaceRelative(file_path);
          // Fall back to use S3 API if the sandbox not configured.
          if (!ws.sandbox) {
            return await s3ReadNumbered(ws.namespace, rel, offset, limit);
          }
          const q = shellQuote(rel);
          const start = typeof offset === "number" && offset > 0 ? offset : 1;
          const end = start + (typeof limit === "number" && limit > 0 ? limit : DEFAULT_LIMIT) - 1;
          const code =
            `if [ ! -f ${q} ]; then printf 'Error: file not found: %s\\n' ${q} >&2; exit 1; fi; ` +
            `sed -n '${start},${end}p' -- ${q} | nl -ba -v ${start}`;
          const result = await runSandbox(ws.sandbox, ws.namespace, code);
          if (!result.ok) {
            return toolError(`${result.stderr}${result.stdout}`.trim() || "Error: read failed");
          }
          return toolText(result.stdout);
        } catch (cause) {
          return toolError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    }),
  };
}
