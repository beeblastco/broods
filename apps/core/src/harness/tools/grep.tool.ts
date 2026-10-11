/**
 * Grep tool. Content search across the workspace, backed by ripgrep (`rg`), or
 * GNU `grep -rE` when the sandbox image ships without it. Mirrors a useful
 * subset of grep. Only registered for
 * sandbox-backed workspaces (read-only workspaces expose read/glob only).
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import {
  resolveWorkspace,
  runSandbox,
  sandboxRunMetadata,
  toWorkspaceRelative,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";
import { shellQuote } from "../sandbox/utils.ts";
import { toolError, toolText } from "./utils.ts";

// Vendored trees grep skips like rg does, unless the search path is inside one.
const VENDORED_DIRS = [".git", "node_modules"];

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

export default function grepTool(context: SandboxToolContext): ToolSet {
  return {
    grep: tool({
      description: `A powerful content search tool over the workspace, built on ripgrep.

Usage notes:
- pattern is a regular expression, e.g. \`function\\s+\\w+\` or \`log.*Error\`. Images without ripgrep run it as \`grep -E\`, so prefer portable syntax (\`[0-9]\` over \`\\d\`).
- output_mode: \`files_with_matches\` (default) returns file paths; \`content\` returns matching lines; \`count\` returns per-file match counts.
- Filter files with the \`glob\` parameter (e.g. \`*.ts\`) and narrow the search root with \`path\`.
- Prefer this over \`bash grep\`/\`rg\` for searching file contents.`,
      inputSchema: jsonSchema<GrepInput>(inputSchema(context)),
      execute: async function (input): Promise<string> {
        const { pattern, workspace } = input;
        try {
          if (typeof pattern !== "string" || pattern.length === 0) {
            return toolError("Error: pattern is required");
          }
          const ws = resolveWorkspace(context.workspaces, workspace);
          if (!ws?.sandbox) {
            return toolError("Error: workspace is read-only");
          }
          const code = searchCommand(input);
          const result = await runSandbox(ws.sandbox, ws.namespace, code, {
            onSandboxCpu: context.onSandboxCpu,
            metadata: sandboxRunMetadata(context, ws),
          });
          // rg and grep agree: exit 0 = matches, 1 = no matches (not an error), >=2 = error.
          // A warning on a no-match run (e.g. grep's "stray \\") explains the miss.
          if (result.exitCode === 1) {
            return toolText(
              ["No matches found", result.stderr.trim()]
                .filter(Boolean)
                .join("\n"),
            );
          }
          if (!result.ok) {
            return toolError(
              `${result.stderr}${result.stdout}`.trim() || "Error: grep failed",
            );
          }
          // grep -c also lists every file with zero matches; rg -c does not.
          const output =
            input.output_mode === "count"
              ? result.stdout
                  .split("\n")
                  .filter((line): boolean => !/(^|:)0$/.test(line))
                  .join("\n")
              : result.stdout;

          return toolText(output.trim() || "No matches found");
        } catch (cause) {
          // toolError throws, so an in-try call already landed here. Feeding its
          // message back through would prefix a fatal setup error a second time.
          throw cause instanceof Error ? cause : new Error(String(cause));
        }
      },
    }),
  };
}

// An rg glob as one grep flag. grep matches names only, so `**/*.py` narrows to
// `*.py` (lossy); a negated directory glob like `!dist/**` skips that directory.
function grepGlobFlag(glob: string): string {
  const exclude = glob.startsWith("!");
  const pattern = glob.replace(/^!/, "");
  const dir = /(?:^|\/)([^/*]+)\/(?:\*\*)?$/.exec(pattern)?.[1];
  if (exclude && dir) return `--exclude-dir=${dir}`;

  return `--${exclude ? "exclude" : "include"}=${pattern.split("/").pop() || "*"}`;
}

function inputSchema(context: SandboxToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);

  return {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression to search for.",
      },
      path: {
        type: "string",
        description:
          "File or directory to search, relative to the workspace root. Defaults to the root.",
      },
      glob: {
        type: "string",
        description: "Glob to filter files, e.g. `*.ts` or `**/*.py`.",
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description:
          "content: matching lines; files_with_matches: file paths (default); count: match counts.",
      },
      case_insensitive: {
        type: "boolean",
        description: "Case-insensitive search.",
      },
      line_numbers: {
        type: "boolean",
        description: "Include line numbers (content mode).",
      },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["pattern"],
    additionalProperties: false,
  };
}

// The sandbox script for one search: ripgrep when the image has it, else GNU grep
// with the same flags, so a custom image without rg still searches.
function searchCommand(input: GrepInput): string {
  const mode: OutputMode = input.output_mode ?? "files_with_matches";
  const flags: string[] = [];
  if (input.case_insensitive) flags.push("-i");
  if (mode === "files_with_matches") flags.push("-l");
  else if (mode === "count") flags.push("-c");
  else if (input.line_numbers) flags.push("-n");
  const path = input.path ? toWorkspaceRelative(input.path) : undefined;
  const tail = ["-e", input.pattern, ...(path ? ["--", path] : [])];
  const inside = new Set(path?.split("/"));
  const rg = [
    "rg",
    ...flags,
    ...(input.glob ? ["-g", input.glob] : []),
    ...tail,
  ];
  // -I skips binaries like rg; no path searches the cwd with clean relative names.
  const grep = [
    "grep",
    "-rIE",
    ...VENDORED_DIRS.filter((dir): boolean => !inside.has(dir)).map(
      (dir): string => `--exclude-dir=${dir}`,
    ),
    ...flags,
    ...(input.glob ? [grepGlobFlag(input.glob)] : []),
    ...tail,
  ];

  return `if command -v rg >/dev/null 2>&1; then ${rg.map(shellQuote).join(" ")}; else ${grep.map(shellQuote).join(" ")}; fi`;
}
