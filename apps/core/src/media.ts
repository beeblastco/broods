/**
 * Public media route — serves one workspace file per sealed ticket.
 *
 * Chat providers store the URL we hand them and fetch it lazily, so this is the
 * durable alternative to a presigned S3 link: storage stays private, the ticket
 * is the only credential, and every fetch is logged. Keep it read-only; anything
 * that needs an account identity belongs behind the authenticated routes.
 */

import { requireEnv } from "./shared/env.ts";
import type { CoreRequest } from "./shared/http.ts";
import { logDebug, logWarn } from "./shared/log.ts";
import { MEDIA_PATH_PREFIX, openMediaTicket } from "./shared/media-ticket.ts";
import { contentTypeForPath } from "./shared/media-types.ts";
import { headS3Object, readS3Bytes } from "./shared/s3.ts";
import { getStorage } from "./shared/storage.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "./harness/sandbox/s3-mount.ts";

// Streaming would buy nothing here: chat pictures are small, and the cap exists
// to stop a large workspace file from sitting in the pod's 1 GiB alongside a run.
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

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
    ? openMediaTicket(token, requireEnv("SERVICE_AUTH_SECRET"))
    : null;
  if (!ticket) {
    logWarn("media.ticket rejected", { path: request.path });

    return notFound();
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

    return notFound();
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

    return notFound();
  }
  if ((head.contentLength ?? 0) > MAX_MEDIA_BYTES) {
    logWarn("media.object too large", {
      accountId: ticket.accountId,
      path: ticket.path,
      contentLength: head.contentLength,
    });

    return new Response("Payload too large", { status: 413 });
  }

  // The extension is the only source. An account on a bring-your-own bucket sets
  // the stored content type itself, so that value is request input, not metadata.
  const contentType = contentTypeForPath(ticket.path);
  const headers: Record<string, string> = {
    "content-type": contentType,
    // This route is unauthenticated and answers on our own origin, so a browser
    // must never sniff its way to a type the extension did not claim, and must
    // never render an SVG here, which would execute script against that origin.
    "x-content-type-options": "nosniff",
    ...(contentType === "image/svg+xml"
      ? { "content-disposition": "attachment" }
      : {}),
    // The ticket names one immutable file, so a provider CDN may hold it forever.
    "cache-control": "public, max-age=31536000, immutable",
    ...(head.contentLength !== undefined
      ? { "content-length": String(head.contentLength) }
      : {}),
  };
  logDebug("media.serve", {
    accountId: ticket.accountId,
    workspaceId: ticket.workspaceId,
    path: ticket.path,
    contentType: contentType,
    contentLength: head.contentLength,
    method: request.method,
  });
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: 200, headers: headers });
  }

  const bytes = target.access
    ? await readS3Bytes(target.bucket, key, target.access)
    : await readS3Bytes(target.bucket, key);

  return new Response(bytes, { status: 200, headers: headers });
}

// One answer for a bad ticket, a deleted workspace and a missing file, so the
// route never tells an anonymous caller which of the three it hit.
function notFound(): Response {
  return new Response("Not found", { status: 404 });
}
