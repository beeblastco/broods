import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import {
  resolveWorkspace,
  runSandbox,
  sandboxRunMetadata,
  toBase64,
  toWorkspaceRelative,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";
import { shellQuote } from "../sandbox/utils.ts";
import { toolError, toolText } from "./utils.ts";

interface WriteInput {
  file_path: string;
  content: string;
  workspace?: string;
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
      execute: async function (input) {
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
          // Without `sync` the mount may not upload before the sandbox freezes: the write is lost.
          const code =
            `mkdir -p "$(dirname -- ${q})" && printf '%s' ${shellQuote(b64)} | base64 -d > ${q} && ` +
            `sync ${q} && ` +
            `printf 'Wrote %s (%s bytes)\\n' ${q} "$(wc -c < ${q})"`;
          const result = await runSandbox(ws.sandbox, ws.namespace, code, {
            onSandboxCpu: context.onSandboxCpu,
            metadata: sandboxRunMetadata(context, ws),
          });
          if (!result.ok) {
            return toolError(
              `${result.stderr}${result.stdout}`.trim() ||
                "Error: write failed",
            );
          }

          return toolText(result.stdout.trim());
        } catch (cause) {
          // toolError already threw; re-wrapping would prefix a setup error twice.
          throw cause instanceof Error ? cause : new Error(String(cause));
        }
      },
    }),
  };
}

function inputSchema(context: SandboxToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);

  return {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to write, relative to the workspace root.",
      },
      content: { type: "string", description: "Full file contents to write." },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  };
}
