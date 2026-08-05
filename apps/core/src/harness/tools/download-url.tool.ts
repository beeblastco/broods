/**
 * Download-url tool — hands the user a durable link to a workspace file. The link
 * is a short opaque handle, not a presigned URL: a 500-character signed URL does
 * not survive being retyped into a chat reply, and the file it points at should
 * still be there tomorrow. The artifact row pins the S3 object *version*, so the
 * link keeps serving the bytes it was minted for after the agent writes a v2.
 *
 * Falls back to a presigned URL when there is no config plane to record into.
 */

import { randomBytes } from "node:crypto";
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import {
  createDownloadArtifact,
  downloadArtifactsAvailable,
} from "../../shared/convex/download-artifacts.ts";
import { getHarnessPublicUrl } from "../../shared/env.ts";
import { getS3ObjectUrl, headS3Object } from "../../shared/s3.ts";
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
  workspace?: string;
}

// Public path of the redirect route in src/server.ts. Kept short on purpose:
// every character is one the model can mistype when it repeats the link.
export const DOWNLOAD_ROUTE_PREFIX = "/d/";
// 128 bits. The token is the whole access check, so it has to be unguessable.
const TOKEN_BYTES = 16;
// Only used by the no-config-plane fallback, where there is nothing to record
// and the raw presigned URL is all we can hand back.
const FALLBACK_EXPIRES_SECONDS = 3600;

export default function downloadUrlTool(context: SandboxToolContext): ToolSet {
  return {
    download_url: tool({
      description: `Creates a download link for a file in the workspace.

Usage notes:
- Use this when the user should be able to open or save a file you produced.
- The link keeps working, and keeps serving the file as it is right now — writing the file again later does not change what an already-shared link downloads.
- Anyone holding the link can download that file, so only mint links for files the user asked for.
- Reproduce the link exactly as returned. Do not shorten, wrap, or retype it.
- The file must already be written to the workspace; this does not upload anything.`,
      inputSchema: jsonSchema(inputSchema(context)),
      async execute(input) {
        const { file_path, workspace } = input as DownloadUrlInput;
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
          const head = await headS3Object(target.bucket, key, target.access);
          if (!head) {
            return toolError(`Error: file not found: ${rel}`);
          }
          const filename = rel.split("/").at(-1)!;
          const base = getHarnessPublicUrl();
          if (!base || !context.accountId || !downloadArtifactsAvailable()) {
            return await presignedFallback(target, key, filename, rel);
          }
          const token = randomBytes(TOKEN_BYTES).toString("base64url");
          await createDownloadArtifact({
            accountId: context.accountId,
            workspaceId: ws.workspaceId,
            token: token,
            bucket: target.bucket,
            key: key,
            ...(head.versionId ? { versionId: head.versionId } : {}),
            path: rel,
            filename: filename,
            ...(head.contentType ? { contentType: head.contentType } : {}),
            ...(head.sizeBytes !== undefined
              ? { sizeBytes: head.sizeBytes }
              : {}),
            ...(context.agentId ? { agentId: context.agentId } : {}),
            ...(context.conversationKey
              ? { conversationKey: context.conversationKey }
              : {}),
          });

          return toolText(
            `Download link for ${rel}:\n${base}${DOWNLOAD_ROUTE_PREFIX}${token}`,
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

// No public URL or no config plane (local dev, self-hosted without Convex): there
// is nowhere to record the artifact and nothing to redirect from, so fall back to
// the raw presigned URL. Bounded by the signing session, which a link cannot outlive.
async function presignedFallback(
  target: { bucket: string; access?: unknown; credentialsExpireAt?: Date },
  key: string,
  filename: string,
  rel: string,
): Promise<ReturnType<typeof toolText>> {
  const remaining = target.credentialsExpireAt
    ? Math.trunc(
        (target.credentialsExpireAt.getTime() - Date.now()) / 1000 - 60,
      )
    : FALLBACK_EXPIRES_SECONDS;
  const expiresInSeconds = Math.min(FALLBACK_EXPIRES_SECONDS, remaining);
  if (expiresInSeconds < 1) {
    return toolError(
      "Error: the workspace credentials are about to expire; retry in a moment",
    );
  }
  const url = await getS3ObjectUrl(target.bucket, key, {
    expiresInSeconds: expiresInSeconds,
    downloadFilename: filename,
    ...(target.access ? { access: target.access as never } : {}),
  });

  return toolText(
    `Download link for ${rel} (expires in ${expiresInSeconds} seconds):\n${url}`,
  );
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
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["file_path"],
    additionalProperties: false,
  };
}
