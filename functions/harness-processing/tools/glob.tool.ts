/**
 * Glob tool — fast file pattern matching in the workspace (supports `**`),
 * returning paths sorted by modification time (newest first), Claude-Code-style.
 * Sandbox-backed workspaces match through the mount; a read-only workspace (no
 * sandbox) lists directly from S3.
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import {
  resolveWorkspace,
  runSandbox,
  s3Glob,
  toBase64,
  toWorkspaceRelative,
  toolError,
  toolText,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";

interface GlobInput {
  pattern: string;
  path?: string;
  workspace?: string;
}

function inputSchema(context: SandboxToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);
  return {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. `**/*.ts` or `src/**/*.py`." },
      path: { type: "string", description: "Directory to search in, relative to the workspace root. Defaults to the root." },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["pattern"],
    additionalProperties: false,
  };
}

function globScript(patternB64: string, rootB64: string): string {
  return [
    "node <<'NODEEOF'",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const pattern = Buffer.from("${patternB64}", "base64").toString("utf8");`,
    `const root = Buffer.from("${rootB64}", "base64").toString("utf8") || ".";`,
    "function escapeRegExp(value) { return value.replace(/[|\\\\{}()[\\]^$+?.]/g, '\\\\$&'); }",
    "function segmentMatcher(segment) {",
    "  const source = [...segment].map((char) => char === '*' ? '[^/]*' : char === '?' ? '[^/]' : escapeRegExp(char)).join('');",
    "  return new RegExp(`^${source}$`);",
    "}",
    "function matches(patternValue, relativePath) {",
    "  const patternParts = patternValue.split('/').filter(Boolean);",
    "  const pathParts = relativePath.split('/').filter(Boolean);",
    "  const matchAt = (patternIndex, pathIndex) => {",
    "    if (patternIndex === patternParts.length) return pathIndex === pathParts.length;",
    "    const part = patternParts[patternIndex];",
    "    if (part === '**') {",
    "      for (let next = pathIndex; next <= pathParts.length; next += 1) {",
    "        if (matchAt(patternIndex + 1, next)) return true;",
    "      }",
    "      return false;",
    "    }",
    "    return pathIndex < pathParts.length && segmentMatcher(part).test(pathParts[pathIndex]) && matchAt(patternIndex + 1, pathIndex + 1);",
    "  };",
    "  return matchAt(0, 0);",
    "}",
    "function walk(dir, prefix = '') {",
    "  let entries;",
    "  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }",
    "  const out = [];",
    "  for (const entry of entries) {",
    "    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;",
    "    const full = path.join(dir, entry.name);",
    "    if (entry.isDirectory()) out.push(...walk(full, rel));",
    "    else if (entry.isFile()) {",
    "      let mtimeMs = 0;",
    "      try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}",
    "      out.push({ rel, mtimeMs });",
    "    }",
    "  }",
    "  return out;",
    "}",
    "const entries = walk(root).filter((entry) => matches(pattern, entry.rel)).sort((a, b) => b.mtimeMs - a.mtimeMs);",
    "process.stdout.write(entries.length > 0 ? `${entries.map((entry) => entry.rel).join('\\n')}\\n` : 'No files found\\n');",
    "NODEEOF",
  ].join("\n");
}

export default function globTool(context: SandboxToolContext): ToolSet {
  return {
    glob: tool({
      description: `Fast file pattern matching in the workspace. Supports glob patterns like \`**/*.ts\` or \`src/**/*.py\`.

Usage notes:
- Returns matching paths (relative to the search root) sorted by modification time, newest first.
- path is the directory to search in, relative to the workspace root; it defaults to the root.
- Prefer this over \`bash find\` for locating files by name.`,
      inputSchema: jsonSchema(inputSchema(context)),
      async execute(input) {
        const { pattern, path, workspace } = input as GlobInput;
        try {
          if (typeof pattern !== "string" || pattern.trim().length === 0) {
            return toolError("Error: pattern is required");
          }
          const ws = resolveWorkspace(context.workspaces, workspace);
          if (!ws) {
            return toolError("Error: no workspace attached");
          }
          // Fall back to use S3 API if the sandbox not configured.
          if (!ws.sandbox) {
            return await s3Glob(ws.namespace, pattern, path);
          }
          const root = path ? toWorkspaceRelative(path) : ".";
          const code = globScript(toBase64(pattern), toBase64(root));
          const result = await runSandbox(ws.sandbox, ws.namespace, code);
          if (!result.ok) {
            return toolError(`${result.stderr}${result.stdout}`.trim() || "Error: glob failed");
          }
          return toolText(result.stdout);
        } catch (cause) {
          return toolError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    }),
  };
}
