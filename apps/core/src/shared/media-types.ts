/**
 * Content types for workspace files, by extension.
 * One table for both ways a file leaves: the media route sets this as the
 * response header for providers that fetch a URL, and the channel tools set it
 * on the attachment for providers that upload bytes. Two tables drift, and the
 * drift is invisible until a file previews on one channel and downloads on
 * another.
 */

const MEDIA_EXTENSION_TYPES: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * A chat client decides whether to preview or download from this type, so an
 * unmapped extension becomes application/octet-stream and every client just
 * downloads it.
 */
export function contentTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";

  return MEDIA_EXTENSION_TYPES[extension] ?? "application/octet-stream";
}
