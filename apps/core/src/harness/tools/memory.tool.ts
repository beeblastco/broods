/**
 * Memory tool — saves one durable fact as a markdown file in the workspace's
 * memory/ folder and keeps memory/MEMORY.md as the index of every memory.
 * Entries carry YAML frontmatter (name, description, metadata) where
 * metadata.originSessionId records the conversation scope the fact was learned
 * in. Ships with the workspace harness (config.harness.memory); recall goes
 * through the normal read/glob/grep tools plus the index the session loads.
 */

import { createHash } from "node:crypto";
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import { workspaceMemoryHarnessEnabled } from "../../shared/domain/workspace-config.ts";
import { channelScopeKeyFromConversation } from "../../shared/runtime-keys.ts";
import {
  resolveWorkspace,
  runSandbox,
  sandboxRunMetadata,
  shellQuote,
  toBase64,
  toolError,
  toolText,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";

export const MEMORY_DIR = "memory";
export const MEMORY_INDEX_PATH = `${MEMORY_DIR}/MEMORY.md`;
export const MEMORY_TYPES = [
  "user",
  "feedback",
  "project",
  "reference",
] as const;

export type MemoryToolContext = SandboxToolContext & {
  conversationKey: string;
};

interface MemorySaveInput {
  title: string;
  description: string;
  content: string;
  type?: (typeof MEMORY_TYPES)[number];
  workspace?: string;
}

export default function memoryTool(context: MemoryToolContext): ToolSet {
  return {
    memory_save: tool({
      description: `Saves one durable fact to your persistent memory so it survives future conversations.

Usage notes:
- The entry is written to memory/<slug>.md and indexed in memory/MEMORY.md (loaded into your context every turn).
- Its metadata records the conversation scope it was learned in (originSessionId), so you can tell where a memory came from when reading it later.
- Check the memory index already in your context first: saving an existing title updates that entry instead of duplicating it.`,
      inputSchema: jsonSchema(inputSchema(context)),
      async execute(input) {
        const { title, description, content, type, workspace } =
          input as MemorySaveInput;
        try {
          const ws = resolveWorkspace(context.workspaces, workspace);
          if (!ws?.sandbox) {
            return toolError("Error: workspace is read-only");
          }
          if (!workspaceMemoryHarnessEnabled(ws.config)) {
            return toolError(
              `Error: the memory harness is disabled for workspace ${ws.name}`,
            );
          }
          // Square brackets would break the index line's markdown link (and the
          // anchored pattern that replaces it), so fold them into spaces.
          const cleanTitle = (title ?? "")
            .replace(/[\[\]]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          const cleanDescription = (description ?? "")
            .replace(/\s+/g, " ")
            .trim();
          if (!cleanTitle) {
            return toolError("Error: title must not be empty");
          }
          if (!cleanDescription) {
            return toolError("Error: description must not be empty");
          }
          const memoryType =
            type && (MEMORY_TYPES as readonly string[]).includes(type)
              ? type
              : "project";
          const originSessionId = channelScopeKeyFromConversation(
            context.conversationKey,
          );
          const slug = memorySlug(cleanTitle);
          const filePath = `${MEMORY_DIR}/${slug}.md`;

          const entry = [
            "---",
            `name: ${slug}`,
            `description: ${JSON.stringify(cleanDescription)}`,
            "metadata:",
            "  node_type: memory",
            `  type: ${memoryType}`,
            `  originSessionId: ${originSessionId}`,
            "---",
            "",
            content ?? "",
            "",
          ].join("\n");
          const indexHeader = "# Memory Index";
          const indexLine = `- [${cleanTitle}](${slug}.md) — ${cleanDescription}`;

          const qFile = shellQuote(filePath);
          const qIndex = shellQuote(MEMORY_INDEX_PATH);
          // Anchored to the entry-defining shape `- [title](slug.md) — ` so a line
          // that merely cross-references this slug in its description never matches.
          // Safe as a BRE: the slug charset is [a-z0-9-] and the title has no `]`.
          const indexLinePattern = `^- \\[[^]]*](${slug}\\.md) — `;
          // Same base64 + `sync` discipline as the write tool: commit both files to
          // the S3 Files server before the sandbox freezes. The entry's index line
          // is REPLACED (matched by its anchored defining line), so re-saving a
          // title updates the summary future turns see instead of keeping the
          // stale line. The workspace is a mountpoint-s3 FUSE mount, which rejects
          // O_APPEND and rename() with EPERM — every file op here must be a whole
          // read or a single create/truncate write stream: the surviving index
          // lines are captured into a shell variable, then the index is rewritten
          // in one `>` pass. No `>>`, no `mv`, no temp files.
          const code =
            `mkdir -p ${shellQuote(MEMORY_DIR)} && printf '%s' ${shellQuote(toBase64(entry))} | base64 -d > ${qFile} && sync ${qFile} && ` +
            `index_body=$({ [ -f ${qIndex} ] && grep -v ${shellQuote(indexLinePattern)} ${qIndex}; } || printf '%s' ${shellQuote(indexHeader)}) && ` +
            `printf '%s\\n%s\\n' "$index_body" ${shellQuote(indexLine)} > ${qIndex} && ` +
            `sync ${qIndex} && printf 'Saved memory %s (indexed in %s)\\n' ${qFile} ${qIndex}`;
          const result = await runSandbox(ws.sandbox, ws.namespace, code, {
            onSandboxCpu: context.onSandboxCpu,
            metadata: sandboxRunMetadata(context, ws),
          });
          if (!result.ok) {
            return toolError(
              `${result.stderr}${result.stdout}`.trim() ||
                "Error: memory save failed",
            );
          }
          return toolText(result.stdout.trim());
        } catch (cause) {
          return toolError(
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      },
    }),
  };
}

// kebab-case file slug from the title (diacritics folded), capped so index lines
// and paths stay short. A capped or empty slug is no longer unique per title, so
// those get a stable hash suffix — distinct titles must never share a file.
export function memorySlug(title: string): string {
  const kebab = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = kebab.slice(0, 60).replace(/-+$/, "");
  if (slug.length > 0 && slug === kebab) {
    return slug;
  }
  const hash = createHash("sha256")
    .update(title, "utf8")
    .digest("hex")
    .slice(0, 8);
  return slug.length > 0 ? `${slug}-${hash}` : `memory-${hash}`;
}

function inputSchema(context: MemoryToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);
  return {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "Short title of the fact; it becomes the entry's file name (kebab-cased).",
      },
      description: {
        type: "string",
        description:
          "One-line summary, shown in the MEMORY.md index and used to decide relevance later.",
      },
      content: {
        type: "string",
        description: "The memory itself (markdown). One fact per entry.",
      },
      type: {
        type: "string",
        enum: [...MEMORY_TYPES],
        description:
          'Kind of memory: "user" for who a person is, "feedback" for guidance or corrections on how to behave, "project" for ongoing work or goals, "reference" for pointers to resources. Defaults to "project".',
      },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["title", "description", "content"],
    additionalProperties: false,
  };
}
