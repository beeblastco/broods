/**
 * Public media route. Serves one file per sealed ticket: a workspace file a
 * channel tool sent out, or an inbound attachment from the attachment store.
 *
 * Chat providers store the URL and fetch it lazily, so this replaces a presigned
 * S3 link: storage stays private, the ticket is the only credential, every fetch
 * is logged. Read-only; anything needing an account identity belongs behind the
 * authenticated routes.
 */

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
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "./harness/sandbox/s3-mount.ts";

// Streaming would buy nothing here: chat pictures are small, and the cap exists
// to stop a large workspace file from sitting in the pod's 1 GiB alongside a run.
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
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: 200, headers: headers });
  }

  const bytes = object.access
    ? await readS3Bytes(object.bucket, object.key, object.access)
    : await readS3Bytes(object.bucket, object.key);

  return new Response(bytes, { status: 200, headers: headers });
}

// The object a ticket names, or null when it is gone. An attachment ticket reads
// the managed bucket on the harness's own role; a workspace ticket goes through
// the workspace's storage, which may be a tenant bucket behind an assumed role.
// Conversation replay asks the same question before a provider fetches a link.
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

// One answer for a bad ticket, a deleted workspace and a missing file, so the
// route never tells an anonymous caller which of the three it hit.
function notFound(): Response {
  return errorResponse(404, "Not found");
}
