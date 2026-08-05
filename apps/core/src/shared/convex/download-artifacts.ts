/**
 * Durable download artifacts: the record behind each short download link. The
 * tool writes one when it mints a link; the public `/d/{token}` route reads it
 * back. Presigning stays in the caller — this file only moves rows.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const internal: any = require("@broods/convex/_generated/api").internal;
import { logError } from "../log.ts";
import { getConvexClient } from "./client.ts";

export interface DownloadArtifact {
  bucket: string;
  key: string;
  versionId?: string;
  filename: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface NewDownloadArtifact extends DownloadArtifact {
  accountId: string;
  workspaceId?: string;
  token: string;
  path: string;
  agentId?: string;
  conversationKey?: string;
}

/** Convex mode is active only when both env vars are present (see CLAUDE.md). */
function convexEnabled(): boolean {
  return Boolean(process.env.CONVEX_URL && process.env.CONVEX_DEPLOY_KEY);
}

export function downloadArtifactsAvailable(): boolean {
  return convexEnabled();
}

// Unlike the sandbox mirrors this is not fire-and-forget: without the row the
// link the caller is about to hand out resolves to nothing.
export async function createDownloadArtifact(
  artifact: NewDownloadArtifact,
): Promise<void> {
  await getConvexClient().mutation(internal.downloadArtifacts.create, {
    accountId: artifact.accountId as any,
    ...(artifact.workspaceId
      ? { workspaceId: artifact.workspaceId as any }
      : {}),
    token: artifact.token,
    bucket: artifact.bucket,
    key: artifact.key,
    ...(artifact.versionId ? { versionId: artifact.versionId } : {}),
    path: artifact.path,
    filename: artifact.filename,
    ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
    ...(artifact.sizeBytes !== undefined
      ? { sizeBytes: artifact.sizeBytes }
      : {}),
    ...(artifact.agentId ? { agentId: artifact.agentId } : {}),
    ...(artifact.conversationKey
      ? { conversationKey: artifact.conversationKey }
      : {}),
  });
}

export async function getDownloadArtifact(
  token: string,
): Promise<DownloadArtifact | null> {
  if (!convexEnabled()) return null;

  return await getConvexClient().query(internal.downloadArtifacts.getByToken, {
    token,
  });
}

// Telemetry only, and it runs after the redirect is decided, so a failure here
// must never cost the user their download.
export async function recordDownloadArtifactHit(token: string): Promise<void> {
  if (!convexEnabled()) return;
  try {
    await getConvexClient().mutation(
      internal.downloadArtifacts.recordDownload,
      {
        token,
      },
    );
  } catch (error) {
    logError("Failed to record download artifact hit", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
