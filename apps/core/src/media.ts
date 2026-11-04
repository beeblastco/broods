// Unauthenticated and read-only: the sealed ticket is the only credential.

import { requireEnv, requireSecretsEnv } from "./shared/env.ts";
import { errorResponse, type CoreRequest } from "./shared/http.ts";
import { logDebug, logWarn } from "./shared/log.ts";
import {
  attachmentStoreKey,
  MEDIA_PATH_PREFIX,
  openMediaTicket,
  type MediaTicket,
} from "./shared/media-ticket.ts";
import { contentTypeForPath } from "./shared/media-types.ts";
import {
  headS3Object,
  readS3Bytes,
  type S3Access,
  type S3ObjectHead,
} from "./shared/s3.ts";
import { getStorage } from "./shared/storage.ts";
import { recordUsage } from "./harness/plan-limits.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "./harness/sandbox/s3-mount.ts";

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

interface MediaObject {
  bucket: string;
  key: string;
  access: S3Access | undefined;
  head: S3ObjectHead;
}

export function routesToMedia(method: string, pathname: string): boolean {
  const upperMethod = method.toUpperCase();

  return (
    pathname.startsWith(MEDIA_PATH_PREFIX) &&
    (upperMethod === "GET" || upperMethod === "HEAD")
  );
}

export async function handleMediaRequest(
  request: CoreRequest,
): Promise<Response> {
  const token = request.path.slice(MEDIA_PATH_PREFIX.length);
  const ticket = token
    ? openMediaTicket(token, requireSecretsEnv("MEDIA_TICKET_SECRET"))
    : null;
  if (!ticket) {
    logWarn("media.ticket rejected", { path: request.path });

    return notFound();
  }

  const object = await locateMediaObject(ticket);
  if (!object) {
    return notFound();
  }
  if ((object.head.contentLength ?? 0) > MAX_MEDIA_BYTES) {
    logWarn("media.object too large", {
      accountId: ticket.accountId,
      path: ticket.path,
      contentLength: object.head.contentLength,
    });

    return errorResponse(413, "Payload too large");
  }

  // Read first, so the cache lifetime counts from when the response leaves, not before a slow read.
  const bytes =
    request.method.toUpperCase() === "HEAD"
      ? null
      : await readMediaObject(object, ticket);
  // From the extension only: a bring-your-own bucket's stored content type is tenant input.
  const contentType = contentTypeForPath(ticket.path);
  const headers: Record<string, string> = {
    "content-type": contentType,
    // Our own origin: no sniffing past the extension's type, and an SVG would run script here.
    "x-content-type-options": "nosniff",
    ...(contentType === "image/svg+xml"
      ? { "content-disposition": "attachment" }
      : {}),
    "cache-control": `public, max-age=${Math.max(0, Math.floor(ticket.exp - Date.now() / 1000))}, immutable`,
    ...(object.head.contentLength !== undefined
      ? { "content-length": String(object.head.contentLength) }
      : {}),
  };
  logDebug("media.serve", {
    accountId: ticket.accountId,
    path: ticket.path,
    contentType: contentType,
    contentLength: object.head.contentLength,
    method: request.method,
  });

  return new Response(bytes, { status: 200, headers: headers });
}

export async function locateMediaObject(
  ticket: MediaTicket,
): Promise<MediaObject | null> {
  if (!("workspaceId" in ticket)) {
    const bucket = requireEnv("FILESYSTEM_BUCKET_NAME");
    const key = attachmentStoreKey(ticket);
    const head = await headS3Object(bucket, key);
    if (!head) {
      logWarn("media.attachment missing", {
        accountId: ticket.accountId,
        path: ticket.path,
      });

      return null;
    }

    return { bucket: bucket, key: key, access: undefined, head: head };
  }

  const record = await getStorage().workspaceConfigs.getById(
    ticket.accountId,
    ticket.workspaceId,
  );
  if (!record) {
    logWarn("media.workspace missing", {
      accountId: ticket.accountId,
      workspaceId: ticket.workspaceId,
    });

    return null;
  }

  const target = await resolveS3ReadTarget(
    workspaceReadContext(record.config.storage, ticket.namespace),
  );
  const key = `${target.prefix}${ticket.path}`;
  const head = target.access
    ? await headS3Object(target.bucket, key, target.access)
    : await headS3Object(target.bucket, key);
  if (!head) {
    logWarn("media.object missing", {
      accountId: ticket.accountId,
      workspaceId: ticket.workspaceId,
      path: ticket.path,
    });

    return null;
  }

  return { bucket: target.bucket, key: key, access: target.access, head: head };
}

// Core runs outside AWS: managed-bucket reads are billed egress; a tenant bucket bills the tenant.
export async function readMediaObject(
  object: MediaObject,
  ticket: MediaTicket,
): Promise<Uint8Array> {
  const bytes = await readS3Bytes(
    object.bucket,
    object.key,
    object.access,
    MAX_MEDIA_BYTES,
  );
  if (!object.access) {
    recordUsage(
      ticket.accountId,
      { egressGb: bytes.byteLength / 1e9 },
      "workspaceId" in ticket ? { workspaceId: ticket.workspaceId } : undefined,
    );
  }

  return bytes;
}

// One answer for a bad ticket, a deleted workspace and a missing file: never say which.
function notFound(): Response {
  return errorResponse(404, "Not found");
}
