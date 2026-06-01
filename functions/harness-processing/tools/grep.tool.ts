/**
 * Grep tool — content search across the workspace, backed by ripgrep (`rg`).
 * Mirrors a useful subset of grep. Only registered for
 * sandbox-backed workspaces (read-only workspaces expose read/glob only).
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import {
  resolveWorkspace,
  runSandbox,
  shellQuote,
  toWorkspaceRelative,
  toolError,
  toolText,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";

type OutputMode = "content" | "files_with_matches" | "count";

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: OutputMode;
  case_insensitive?: boolean;
  line_numbers?: boolean;
  workspace?: string;
}

function inputSchema(context: SandboxToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);
  return {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for (ripgrep syntax)." },
      path: { type: "string", description: "File or directory to search, relative to the workspace root. Defaults to the root." },
      glob: { type: "string", description: "Glob to filter files, e.g. `*.ts` or `**/*.py`." },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "content: matching lines; files_with_matches: file paths (default); count: match counts.",
      },
      case_insensitive: { type: "boolean", description: "Case-insensitive search." },
      line_numbers: { type: "boolean", description: "Include line numbers (content mode)." },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["pattern"],
    additionalProperties: false,
  };
}

export default function grepTool(context: SandboxToolContext): ToolSet {
  return {
    grep: tool({
      description: `A powerful content search tool over the workspace, built on ripgrep.

Usage notes:
- pattern is a regular expression (ripgrep syntax), e.g. \`function\\s+\\w+\` or \`log.*Error\`.
- output_mode: \`files_with_matches\` (default) returns file paths; \`content\` returns matching lines; \`count\` returns per-file match counts.
- Filter files with the \`glob\` parameter (e.g. \`*.ts\`) and narrow the search root with \`path\`.
- Prefer this over \`bash grep\`/\`rg\` for searching file contents.`,
      inputSchema: jsonSchema(inputSchema(context)),
      async execute(input) {
        const { pattern, path, glob, output_mode, case_insensitive, line_numbers, workspace } = input as GrepInput;
        try {
          if (typeof pattern !== "string" || pattern.length === 0) {
            return toolError("Error: pattern is required");
          }
          const ws = resolveWorkspace(context.workspaces, workspace);
          if (!ws?.sandbox) {
            return toolError("Error: workspace is read-only");
          }
          const mode: OutputMode = output_mode ?? "files_with_matches";

          const args = ["rg"];
          if (case_insensitive) args.push("-i");
          if (mode === "files_with_matches") args.push("-l");
          else if (mode === "count") args.push("-c");
          else if (line_numbers) args.push("-n");
          if (glob) args.push("-g", glob);
          args.push("-e", pattern);
          if (path) args.push("--", toWorkspaceRelative(path));

          const code = args.map(shellQuote).join(" ");
          const result = await runSandbox(ws.sandbox, ws.namespace, code);
          // ripgrep: exit 0 = matches, 1 = no matches (not an error), >=2 = error.
          if (result.exitCode === 1 && result.stderr.trim().length === 0) {
            return toolText("No matches found");
          }
          if (!result.ok && result.exitCode !== 1) {
            return toolError(`${result.stderr}${result.stdout}`.trim() || "Error: grep failed");
          }
          return toolText(result.stdout.trim() || "No matches found");
        } catch (cause) {
          return toolError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    }),
  };
}
