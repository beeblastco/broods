/**
 * Edit tool — exact string replacement in a workspace file (Claude-Code-style:
 * old_string must be unique unless replace_all). Implemented with a Node
 * heredoc; path/strings are base64-passed so no content can break quoting.
 * Only registered for sandbox-backed workspaces (read-only workspaces cannot edit).
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import {
  editNeedsApproval,
  resolveWorkspace,
  runSandbox,
  toBase64,
  toWorkspaceRelative,
  toolError,
  toolText,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  workspace?: string;
}

function inputSchema(context: SandboxToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);
  return {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to edit, relative to the workspace root." },
      old_string: { type: "string", description: "The exact text to replace." },
      new_string: { type: "string", description: "The replacement text (must differ from old_string)." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  };
}

function editScript(pathB64: string, oldB64: string, newB64: string, replaceAll: boolean): string {
  return [
    "node <<'NODEEOF'",
    "const fs = require('node:fs');",
    `const path = Buffer.from("${pathB64}", "base64").toString("utf8");`,
    `const oldString = Buffer.from("${oldB64}", "base64").toString("utf8");`,
    `const newString = Buffer.from("${newB64}", "base64").toString("utf8");`,
    `const replaceAll = ${replaceAll ? "true" : "false"};`,
    "function fail(message) { process.stderr.write(message + '\\n'); process.exit(1); }",
    "if (oldString.length === 0) fail('Error: old_string must not be empty');",
    "if (oldString === newString) fail('Error: old_string and new_string are identical');",
    "let data;",
    "try {",
    "  data = fs.readFileSync(path, 'utf8');",
    "} catch (error) {",
    "  if (error && error.code === 'ENOENT') fail(`Error: file not found: ${path}`);",
    "  throw error;",
    "}",
    "const count = data.split(oldString).length - 1;",
    "if (count === 0) fail(`Error: old_string not found in ${path}`);",
    "if (!replaceAll && count > 1) fail(`Error: old_string is not unique (${count} matches); add context or set replace_all`);",
    "const updated = replaceAll ? data.split(oldString).join(newString) : data.replace(oldString, newString);",
    // fsync the rewrite so it commits to the S3 Files server before the Lambda freezes;
    // a plain writeFileSync can be lost on the next cold container. See docs/workspace/sandbox/lambda.md.
    "const fd = fs.openSync(path, 'w');",
    "try { fs.writeSync(fd, updated, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }",
    "const replacements = replaceAll ? count : 1;",
    "process.stdout.write(`Edited ${path} (${replacements} replacement${replacements === 1 ? '' : 's'})\\n`);",
    "NODEEOF",
  ].join("\n");
}

export default function editTool(context: SandboxToolContext): ToolSet {
  return {
    edit: tool({
      description: `Performs exact string replacements in a workspace file.

Usage notes:
- file_path is relative to the workspace root.
- old_string must match the file contents exactly, including whitespace and indentation, and must be unique unless replace_all is true; otherwise the edit fails.
- new_string must differ from old_string.
- The edit fails if the file does not exist — use the \`write\` tool to create new files.`,
      inputSchema: jsonSchema(inputSchema(context)),
      needsApproval: (input) => editNeedsApproval(context.workspaces, (input as EditInput).workspace),
      async execute(input) {
        const { file_path, old_string, new_string, replace_all, workspace } = input as EditInput;
        try {
          const ws = resolveWorkspace(context.workspaces, workspace);
          if (!ws?.sandbox) {
            return toolError("Error: workspace is read-only");
          }
          const rel = toWorkspaceRelative(file_path);
          if (rel === ".") {
            return toolError("Error: file_path must reference a file");
          }
          const code = editScript(
            toBase64(rel),
            toBase64(old_string ?? ""),
            toBase64(new_string ?? ""),
            replace_all === true,
          );
          const result = await runSandbox(ws.sandbox, ws.namespace, code);
          if (!result.ok) {
            return toolError(`${result.stderr}${result.stdout}`.trim() || "Error: edit failed");
          }
          return toolText(result.stdout.trim());
        } catch (cause) {
          return toolError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    }),
  };
}
