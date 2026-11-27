import { SHELL_ONLY_SANDBOX_PROVIDERS } from "@broods/convex/model/sandboxProviders";
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
import type { SandboxRunResult } from "../sandbox/types.ts";
import { shellQuote } from "../sandbox/utils.ts";
import { toolError } from "./utils.ts";

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  workspace?: string;
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
      execute: async function (input) {
        const { file_path, old_string, new_string, replace_all, workspace } =
          input as EditInput;
        try {
          const ws = resolveWorkspace(context.workspaces, workspace);
          if (!ws?.sandbox) {
            return toolError("Error: workspace is read-only");
          }
          const rel = toWorkspaceRelative(file_path);
          if (rel === ".") {
            return toolError("Error: file_path must reference a file");
          }
          const sandbox = ws.sandbox;
          const options = {
            onSandboxCpu: context.onSandboxCpu,
            metadata: sandboxRunMetadata(context, ws),
          };
          if (SHELL_ONLY_SANDBOX_PROVIDERS.has(sandbox.provider)) {
            return await editOnShell(
              (code) => runSandbox(sandbox, ws.namespace, code, options),
              rel,
              old_string ?? "",
              new_string ?? "",
              replace_all === true,
            );
          }
          const code = editScript(
            toBase64(rel),
            toBase64(old_string ?? ""),
            toBase64(new_string ?? ""),
            replace_all === true,
          );
          const result = await runSandbox(
            ws.sandbox,
            ws.namespace,
            code,
            options,
          );
          if (!result.ok) {
            return toolError(
              `${result.stderr}${result.stdout}`.trim() || "Error: edit failed",
            );
          }

          return result.stdout.trim();
        } catch (cause) {
          // toolError throws; rethrow as is so a fatal setup error is not prefixed twice.
          throw cause instanceof Error ? cause : new Error(String(cause));
        }
      },
    }),
  };
}

// The node script's rules, run in core: read the file out, replace here, write it back.
async function editOnShell(
  run: (code: string) => Promise<SandboxRunResult>,
  rel: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<string> {
  if (oldString.length === 0) toolError("Error: old_string must not be empty");
  if (oldString === newString)
    toolError("Error: old_string and new_string are identical");
  const q = shellQuote(`./${rel}`);
  const read = await run(
    `if [ ! -f ${q} ]; then printf 'Error: file not found: %s\\n' ${shellQuote(rel)} >&2; exit 1; fi; base64 -w0 ${q}`,
  );
  if (!read.ok)
    toolError(`${read.stderr}${read.stdout}`.trim() || "Error: edit failed");
  // A cut read written back would drop the rest of the file.
  if (read.truncated)
    toolError(`Error: ${rel} is too large to edit here; rewrite it with write`);
  const data = Buffer.from(read.stdout.trim(), "base64").toString("utf8");
  const count = data.split(oldString).length - 1;
  if (count === 0) toolError(`Error: old_string not found in ${rel}`);
  if (!replaceAll && count > 1)
    toolError(
      `Error: old_string is not unique (${count} matches); add context or set replace_all`,
    );
  const updated = replaceAll
    ? data.split(oldString).join(newString)
    : data.replace(oldString, () => newString);
  const wrote = await run(
    `printf '%s' ${shellQuote(toBase64(updated))} | base64 -d > ${q}`,
  );
  if (!wrote.ok)
    toolError(`${wrote.stderr}${wrote.stdout}`.trim() || "Error: edit failed");
  const replacements = replaceAll ? count : 1;

  return `Edited ${rel} (${replacements} replacement${replacements === 1 ? "" : "s"})`;
}

function editScript(
  pathB64: string,
  oldB64: string,
  newB64: string,
  replaceAll: boolean,
): string {
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
    "const updated = replaceAll ? data.split(oldString).join(newString) : data.replace(oldString, () => newString);",
    // fsync so the mount uploads before the sandbox can freeze; see docs/internals/storage.md.
    "const fd = fs.openSync(path, 'w');",
    "try { fs.writeSync(fd, updated, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }",
    "const replacements = replaceAll ? count : 1;",
    "process.stdout.write(`Edited ${path} (${replacements} replacement${replacements === 1 ? '' : 's'})\\n`);",
    "NODEEOF",
  ].join("\n");
}

function inputSchema(context: SandboxToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);

  return {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to edit, relative to the workspace root.",
      },
      old_string: { type: "string", description: "The exact text to replace." },
      new_string: {
        type: "string",
        description: "The replacement text (must differ from old_string).",
      },
      replace_all: {
        type: "boolean",
        description:
          "Replace every occurrence instead of requiring a unique match.",
      },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  };
}
