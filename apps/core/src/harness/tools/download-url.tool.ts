/**
 * Download-url tool — mints a short-lived presigned link to a workspace file so the
 * agent can hand the user something clickable. Reads the workspace's storage
 * directly (the same bucket/prefix the mount exposes), so it never needs the
 * sandbox and works for read-only workspaces too.
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import { getS3ObjectUrl, s3ObjectExists } from "../../shared/s3.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "../sandbox/s3-mount.ts";
import {
  resolveWorkspace,
  toWorkspaceRelative,
  toolError,
  toolText,
  workspaceParamSchema,
  type SandboxToolContext,
} from "./filesystem-utils.ts";

interface DownloadUrlInput {
  file_path: string;
  expires_in?: number;
  workspace?: string;
}

// Long enough to survive a chat round trip, short enough that a link pasted into a
// channel stops working well before it becomes a durable, unauthenticated handle.
const DEFAULT_EXPIRES_SECONDS = 900;
const MAX_EXPIRES_SECONDS = 3600;
// A presigned URL dies with the credentials that signed it, so a link is never
// promised past the assumed session, minus a margin for the clock and the round trip.
const CREDENTIAL_EXPIRY_MARGIN_SECONDS = 60;

export default function downloadUrlTool(context: SandboxToolContext): ToolSet {
  return {
    download_url: tool({
      description: `Creates a temporary download link for a file in the workspace.

Usage notes:
- Use this when the user should be able to open or save a file you produced.
- The link expires (default ${DEFAULT_EXPIRES_SECONDS} seconds), so mint it when you are about to share it, not in advance.
- Anyone holding the link can download the file until it expires — only mint links for files the user asked for.
- The file must already be written to the workspace; this does not upload anything.`,
      inputSchema: jsonSchema(inputSchema(context)),
      async execute(input) {
        const { file_path, expires_in, workspace } = input as DownloadUrlInput;
        try {
          const ws = resolveWorkspace(context.workspaces, workspace);
          if (!ws) {
            return toolError("Error: no workspace available for this command");
          }
          const rel = toWorkspaceRelative(file_path);
          if (rel === ".") {
            return toolError("Error: file_path is required");
          }
          const target = await resolveS3ReadTarget(
            workspaceReadContext(ws.config.storage, ws.namespace),
          );
          const key = `${target.prefix}${rel}`;
          if (!(await s3ObjectExists(target.bucket, key, target.access))) {
            return toolError(`Error: file not found: ${rel}`);
          }
          const expiresInSeconds = expirySeconds(
            expires_in,
            target.credentialsExpireAt,
          );
          if (expiresInSeconds < 1) {
            return toolError(
              "Error: the workspace credentials are about to expire; retry in a moment",
            );
          }
          const url = await getS3ObjectUrl(target.bucket, key, {
            expiresInSeconds: expiresInSeconds,
            ...(target.access ? { access: target.access } : {}),
          });

          return toolText(
            `Download link for ${rel} (expires in ${expiresInSeconds} seconds):\n${url}`,
          );
        } catch (cause) {
          return toolError(
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      },
    }),
  };
}

// The requested lifetime, bounded by the tool's own cap and by whatever is left of
// the signing session — a link outliving its credentials just 403s when clicked.
function expirySeconds(
  requested: number | undefined,
  credentialsExpireAt?: Date,
): number {
  // The model supplies `requested`; a non-finite one would carry NaN all the way to
  // the presigner, and NaN passes every comparison the caller makes afterwards.
  const bounded = Math.min(
    Math.max(
      Number.isFinite(requested)
        ? Math.trunc(requested as number)
        : DEFAULT_EXPIRES_SECONDS,
      1,
    ),
    MAX_EXPIRES_SECONDS,
  );
  if (!credentialsExpireAt) return bounded;
  const remaining = Math.trunc(
    (credentialsExpireAt.getTime() - Date.now()) / 1000 -
      CREDENTIAL_EXPIRY_MARGIN_SECONDS,
  );

  return Math.min(bounded, remaining);
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
      expires_in: {
        type: "integer",
        description: `Seconds the link stays valid (default ${DEFAULT_EXPIRES_SECONDS}, max ${MAX_EXPIRES_SECONDS}).`,
      },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["file_path"],
    additionalProperties: false,
  };
}
