/**
 * Write tool — writes a file to the workspace (creating parent dirs), overwriting
 * if it exists. Content is base64-piped to avoid any quoting hazards. Only
 * registered for sandbox-backed workspaces (read-only workspaces cannot write).
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import {
  editNeedsApproval,
  resolveWorkspace,
  runSandbox,
  shellQuote,
  toBase64,
  toWorkspaceRelative,
  toolError,
  toolText,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";

interface WriteInput {
  file_path: string;
  content: string;
  workspace?: string;
}

function inputSchema(context: SandboxToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);
  return {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to write, relative to the workspace root." },
      content: { type: "string", description: "Full file contents to write." },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  };
}

export default function writeTool(context: SandboxToolContext): ToolSet {
  return {
    write: tool({
      description: `Writes a file to the workspace, overwriting it if it already exists.

Usage notes:
- file_path is relative to the workspace root; missing parent directories are created.
- Prefer editing an existing file with the \`edit\` tool over overwriting it with \`write\`.
- Always prefer this over \`bash\` redirection for creating files.`,
      inputSchema: jsonSchema(inputSchema(context)),
      needsApproval: (input) => editNeedsApproval(context.workspaces, (input as WriteInput).workspace),
      async execute(input) {
        const { file_path, content, workspace } = input as WriteInput;
        try {
          const ws = resolveWorkspace(context.workspaces, workspace);
          if (!ws?.sandbox) {
            return toolError("Error: workspace is read-only");
          }
          const rel = toWorkspaceRelative(file_path);
          if (rel === ".") {
            return toolError("Error: file_path must reference a file");
          }
          const q = shellQuote(rel);
          const b64 = toBase64(content ?? "");
          // `sync ${q}` fsyncs the file so the write commits to the S3 Files server
          // before the Lambda freezes; without it a cold container loses the write
          // (close alone does not force an NFS COMMIT). See docs/workspace/sandbox/lambda.md.
          const code =
            `mkdir -p "$(dirname -- ${q})" && printf '%s' ${shellQuote(b64)} | base64 -d > ${q} && ` +
            `sync ${q} && ` +
            `printf 'Wrote %s (%s bytes)\\n' ${q} "$(wc -c < ${q})"`;
          const result = await runSandbox(ws.sandbox, ws.namespace, code);
          if (!result.ok) {
            return toolError(`${result.stderr}${result.stdout}`.trim() || "Error: write failed");
          }
          return toolText(result.stdout.trim());
        } catch (cause) {
          return toolError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    }),
  };
}
