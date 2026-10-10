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
      description: `A powerful content search tool over the workspace, built on ripgrep (GNU grep -E on images without it).

Usage notes:
- pattern is a regular expression, e.g. \`function\\s+\\w+\` or \`log.*Error\`. Images without ripgrep run it as \`grep -E\`, so prefer portable syntax (\`[0-9]\` over \`\\d\`).
- output_mode: \`files_with_matches\` (default) returns file paths; \`content\` returns matching lines; \`count\` returns per-file match counts.
- Filter files with the \`glob\` parameter (e.g. \`*.ts\`) and narrow the search root with \`path\`.
- Prefer this over \`bash grep\`/\`rg\` for searching file contents.`,
      inputSchema: jsonSchema<GrepInput>(inputSchema(context)),
      execute: async function (input) {
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

// An rg glob as grep --include/--exclude flags. grep matches the file name only, so
// `**/*.py` narrows to `*.py`; `!` excludes like rg, and one `{a,b}` group expands,
// since grep's fnmatch has no braces.
function grepGlobFlags(glob: string): string[] {
  const exclude = glob.startsWith("!");
  const name = glob.replace(/^!/, "").split("/").pop() || "*";
  const [, before, options, after] = /^(.*)\{([^{}]*)\}(.*)$/.exec(name) ?? [];
  const names =
    options === undefined
      ? [name]
      : options.split(",").map((part): string => `${before}${part}${after}`);

  return names.map(
    (each): string => `--${exclude ? "exclude" : "include"}=${each}`,
  );
}

function inputSchema(context: SandboxToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);

  return {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Regular expression to search for (ripgrep syntax, or grep -E where ripgrep is missing).",
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
  const rg = ["rg"];
  // Like rg, skip binaries and the usual vendored trees. No path searches the
  // cwd with clean relative names.
  const grep = [
    "grep",
    "-rIE",
    "--exclude-dir=.git",
    "--exclude-dir=node_modules",
  ];
  const shared: string[] = [];
  if (input.case_insensitive) shared.push("-i");
  if (mode === "files_with_matches") shared.push("-l");
  else if (mode === "count") shared.push("-c");
  else if (input.line_numbers) shared.push("-n");
  rg.push(...shared);
  grep.push(...shared);
  if (input.glob) {
    rg.push("-g", input.glob);
    grep.push(...grepGlobFlags(input.glob));
  }
  for (const args of [rg, grep]) {
    args.push("-e", input.pattern);
    if (input.path) args.push("--", toWorkspaceRelative(input.path));
  }
  const ripgrep = rg.map(shellQuote).join(" ");
  const fallback = grep.map(shellQuote).join(" ");

  return `if command -v rg >/dev/null 2>&1; then ${ripgrep}; else ${fallback}; fi`;
}
