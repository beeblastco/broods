import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import {
  resolveWorkspace,
  runSandbox,
  s3ReadNumbered,
  sandboxRunMetadata,
  toWorkspaceRelative,
  workspaceMediaBytes,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";
import { contentTypeForPath } from "../../shared/media-types.ts";
import { acceptsNativeMedia } from "../channel-media.ts";
import type { ResolvedWorkspace } from "../../shared/workspaces.ts";
import type { AgentConfig } from "../../shared/domain/agent-config.ts";
import { shellQuote } from "../sandbox/utils.ts";
import {
  transcribeAudio,
  TRANSCRIPTION_RETRIES,
  transcriptAdvice,
} from "../transcribe.ts";
import { toolError, toolText } from "./utils.ts";

const DEFAULT_LIMIT = 2000;

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  workspace?: string;
}

export default function readTool(context: SandboxToolContext): ToolSet {
  return {
    read: tool({
      description: `Reads a file from the workspace, returning its contents with line numbers (cat -n style).

Usage notes:
- file_path is relative to the workspace root.
- Reads up to ${DEFAULT_LIMIT} lines from the start by default; use offset and limit to page through large files.
- Lines are returned as \`<line_number>\\t<content>\`.
- Prefer this over \`bash cat\` for reading files.
- Reading an audio file returns its transcript rather than its bytes.`,
      inputSchema: jsonSchema(inputSchema(context)),
      execute: async function (input) {
        const { file_path, offset, limit, workspace } = input as ReadInput;
        try {
          const ws = resolveWorkspace(context.workspaces, workspace);
          if (!ws) {
            return toolError("Error: no workspace attached");
          }
          const rel = toWorkspaceRelative(file_path);
          const spoken = await spokenContents(context.agentConfig, ws, rel);
          if (spoken) {
            return spoken;
          }
          const runner = ws.sandbox ?? ws.readMount;
          if (!runner) {
            return await s3ReadNumbered(ws, rel, offset, limit);
          }
          const q = shellQuote(rel);
          const start = typeof offset === "number" && offset > 0 ? offset : 1;
          const end =
            start +
            (typeof limit === "number" && limit > 0 ? limit : DEFAULT_LIMIT) -
            1;
          const code =
            `if [ ! -f ${q} ]; then printf 'Error: file not found: %s\\n' ${q} >&2; exit 1; fi; ` +
            `sed -n '${start},${end}p' -- ${q} | nl -ba -v ${start}`;
          const result = await runSandbox(runner, ws.namespace, code, {
            metadata: sandboxRunMetadata(context, ws),
          });
          if (!result.ok) {
            return toolError(
              `${result.stderr}${result.stdout}`.trim() || "Error: read failed",
            );
          }

          return toolText(result.stdout);
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
        description: "Path to the file, relative to the workspace root.",
      },
      offset: {
        type: "integer",
        description: "1-based line number to start reading from.",
      },
      limit: {
        type: "integer",
        description: `Maximum number of lines to read (default ${DEFAULT_LIMIT}).`,
      },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["file_path"],
    additionalProperties: false,
  };
}

// A provider that hears audio itself reads the recording, not a worse transcript.
async function spokenContents(
  agentConfig: AgentConfig | undefined,
  ws: ResolvedWorkspace,
  rel: string,
): Promise<string | null> {
  const mediaType = contentTypeForPath(rel);
  if (
    !agentConfig ||
    !mediaType.startsWith("audio/") ||
    acceptsNativeMedia(agentConfig.model?.provider, mediaType)
  ) {
    return null;
  }
  // Unreadable: the line reader reports the missing file in the agent's usual words.
  const bytes = await workspaceMediaBytes(ws, rel).catch(() => undefined);
  if (!bytes) {
    return null;
  }
  const transcript = await transcribeAudio(
    agentConfig,
    bytes,
    TRANSCRIPTION_RETRIES.tool,
  );
  if (transcript.status !== "transcribed") {
    return toolError(
      `Error: ${rel} could not be transcribed: ${transcript.reason}. ${transcriptAdvice(transcript.recovery, rel)}`,
    );
  }

  return toolText(
    transcript.text
      ? `Transcript of ${rel}:\n\n${transcript.text}`
      : `${rel} contains no speech.`,
  );
}
