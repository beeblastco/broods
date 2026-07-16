/**
 * Memory tool — saves one durable fact as a markdown file in the workspace's
 * memory/ folder and keeps memory/MEMORY.md as the index of every memory.
 * Entries carry YAML frontmatter (name, description, metadata) where
 * metadata.originSessionId records the conversation scope the fact was learned
 * in. Ships with the workspace harness (config.harness.memory); recall goes
 * through the normal read/glob/grep tools plus the index the session loads.
 */

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
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryToolContext = SandboxToolContext & { conversationKey: string };

interface MemorySaveInput {
  title: string;
  description: string;
  content: string;
  type?: (typeof MEMORY_TYPES)[number];
  workspace?: string;
}

function inputSchema(context: MemoryToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);
  return {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title of the fact; it becomes the entry's file name (kebab-cased)." },
      description: { type: "string", description: "One-line summary, shown in the MEMORY.md index and used to decide relevance later." },
      content: { type: "string", description: "The memory itself (markdown). One fact per entry." },
      type: {
        type: "string",
        enum: [...MEMORY_TYPES],
        description: "Kind of memory: \"user\" for who a person is, \"feedback\" for guidance or corrections on how to behave, \"project\" for ongoing work or goals, \"reference\" for pointers to resources. Defaults to \"project\".",
      },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["title", "description", "content"],
    additionalProperties: false,
  };
}

// kebab-case file slug from the title; capped so index lines and paths stay short.
export function memorySlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "memory";
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
        const { title, description, content, type, workspace } = input as MemorySaveInput;
        try {
          const ws = resolveWorkspace(context.workspaces, workspace);
          if (!ws?.sandbox) {
            return toolError("Error: workspace is read-only");
          }
          if (!workspaceMemoryHarnessEnabled(ws.config)) {
            return toolError(`Error: the memory harness is disabled for workspace ${ws.name}`);
          }
          const cleanTitle = (title ?? "").replace(/\s+/g, " ").trim();
          const cleanDescription = (description ?? "").replace(/\s+/g, " ").trim();
          if (!cleanTitle) {
            return toolError("Error: title must not be empty");
          }
          if (!cleanDescription) {
            return toolError("Error: description must not be empty");
          }
          const memoryType = type && (MEMORY_TYPES as readonly string[]).includes(type) ? type : "project";
          const originSessionId = channelScopeKeyFromConversation(context.conversationKey);
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
          const indexHeader = "# Memory Index\n";
          const indexLine = `- [${cleanTitle}](${slug}.md) — ${cleanDescription}`;

          const qFile = shellQuote(filePath);
          const qIndex = shellQuote(MEMORY_INDEX_PATH);
          const qIndexTmp = shellQuote(`${MEMORY_INDEX_PATH}.tmp`);
          // Same base64 + `sync` discipline as the write tool: commit both files to
          // the S3 Files server before the sandbox freezes. The entry's index line
          // is REPLACED (matched by its link target), so re-saving a title updates
          // the summary future turns see instead of keeping the stale line.
          const code =
            `mkdir -p ${shellQuote(MEMORY_DIR)} && printf '%s' ${shellQuote(toBase64(entry))} | base64 -d > ${qFile} && sync ${qFile} && ` +
            `{ [ -f ${qIndex} ] || printf '%s\\n' ${shellQuote(indexHeader)} > ${qIndex}; } && ` +
            `{ grep -vF ${shellQuote(`](${slug}.md)`)} ${qIndex} > ${qIndexTmp} || true; } && ` +
            `printf '%s\\n' ${shellQuote(indexLine)} >> ${qIndexTmp} && mv ${qIndexTmp} ${qIndex} && ` +
            `sync ${qIndex} && printf 'Saved memory %s (indexed in %s)\\n' ${qFile} ${qIndex}`;
          const result = await runSandbox(ws.sandbox, ws.namespace, code, {
            onSandboxCpu: context.onSandboxCpu,
            metadata: sandboxRunMetadata(context, ws),
          });
          if (!result.ok) {
            return toolError(`${result.stderr}${result.stdout}`.trim() || "Error: memory save failed");
          }
          return toolText(result.stdout.trim());
        } catch (cause) {
          return toolError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    }),
  };
}
