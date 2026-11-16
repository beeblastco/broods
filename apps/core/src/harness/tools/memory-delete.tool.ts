import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import { workspaceMemoryHarnessEnabled } from "../../shared/domain/workspace-config.ts";
import { shellQuote } from "../sandbox/utils.ts";
import {
  resolveWorkspace,
  runSandbox,
  sandboxRunMetadata,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";
import { MEMORY_DIR, MEMORY_INDEX_PATH, memorySlug } from "./memory.tool.ts";
import { toolError } from "./utils.ts";

interface MemoryDeleteInput {
  title: string;
  workspace?: string;
}

// Registered next to memory_save; removes one memory file and its index line in one command.
export default function memoryDeleteTool(context: SandboxToolContext): ToolSet {
  return {
    memory_delete: tool({
      description: `Deletes one memory that turned out wrong or no longer holds, so future conversations stop loading it.

Usage notes:
- Pass the title as the memory/MEMORY.md index shows it. The file memory/<slug>.md and its index line are removed together.
- To correct a memory instead, save it again with memory_save under the same title.`,
      inputSchema: jsonSchema(inputSchema(context)),
      execute: async function (input): Promise<string> {
        const { title, workspace } = input as MemoryDeleteInput;
        const ws = resolveWorkspace(context.workspaces, workspace);
        if (!ws?.sandbox) {
          return toolError("Error: workspace is read-only");
        }
        if (!workspaceMemoryHarnessEnabled(ws.config)) {
          return toolError(
            `Error: the memory harness is disabled for workspace ${ws.name}`,
          );
        }
        if (!(title ?? "").trim()) {
          return toolError("Error: title must not be empty");
        }
        // The policy check derives the path the same way, so a path rule cannot be stepped around.
        const slug = memorySlug(title);

        const qFile = shellQuote(`${MEMORY_DIR}/${slug}.md`);
        const qIndex = shellQuote(MEMORY_INDEX_PATH);
        // Same anchored line shape memory_save writes, so a cross-reference is never removed.
        const qPattern = shellQuote(`^- \\[[^]]*](${slug}\\.md) — `);
        // mountpoint-s3 rejects O_APPEND and rename(), so the index is rewritten in one `>`.
        const code =
          `if [ ! -f ${qFile} ] && ! { [ -f ${qIndex} ] && grep -q ${qPattern} ${qIndex}; }; then ` +
          `printf 'Error: no memory at %s\\n' ${qFile} >&2; exit 1; fi && ` +
          `rm -f ${qFile} && ` +
          `if [ -f ${qIndex} ]; then index_body=$(grep -v ${qPattern} ${qIndex} || true) && ` +
          `printf '%s\\n' "$index_body" > ${qIndex} && sync ${qIndex}; fi && ` +
          `printf 'Deleted memory %s (removed from %s)\\n' ${qFile} ${qIndex}`;
        const result = await runSandbox(ws.sandbox, ws.namespace, code, {
          onSandboxCpu: context.onSandboxCpu,
          metadata: sandboxRunMetadata(context, ws),
        });
        if (!result.ok) {
          return toolError(
            `${result.stderr}${result.stdout}`.trim() ||
              "Error: memory delete failed",
          );
        }

        return result.stdout.trim();
      },
    }),
  };
}

function inputSchema(context: SandboxToolContext): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(context.workspaces);

  return {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "Title of the memory exactly as the memory/MEMORY.md index shows it.",
      },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["title"],
    additionalProperties: false,
  };
}
