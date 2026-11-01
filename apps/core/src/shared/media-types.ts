// Matches the media route: past it the route answers 413 and the link handed out is dead.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Models read images inline, and a 25 MB one costs far more tokens than it carries.
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const MEDIA_EXTENSION_TYPES: Record<string, string> = {
  aac: "audio/aac",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  flac: "audio/flac",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  wav: "audio/wav",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function contentTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";

  return MEDIA_EXTENSION_TYPES[extension] ?? "application/octet-stream";
}

export function unreadableMediaNote(
  filename: string | undefined,
  mediaType: string,
): string {
  return `[${filename ?? "attachment"} (${mediaType}) was not shown to you: this model does not accept the type. Open it with read if it was saved to a workspace.]`;
}
