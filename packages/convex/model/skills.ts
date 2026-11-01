import {
  contentTypeForSkillPath,
  normalizeBundlePath,
  parseGitHubSkillUrl,
  parseSkillMarkdown,
  validateSkillDescription,
  validateSkillName,
  MAX_SKILL_METADATA_BYTES,
  SKILL_FILE,
} from "./skillRules";
import {
  deleteS3Prefix,
  listS3Prefix,
  readS3Bytes,
  readS3Text,
  writeS3Object,
} from "./s3";
import { ClientError } from "./clientError";

const MAX_SKILL_BUNDLE_BYTES = 30 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;

const MAX_SKILL_ARCHIVE_BYTES = 2 * MAX_SKILL_BUNDLE_BYTES;

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export interface SkillBundleFile {
  path: string;
  bytes: Uint8Array;
  contentType?: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
}

export interface StoredSkill extends SkillMetadata {
  files: Array<{ path: string; size?: number }>;
}

export interface ValidatedSkillBundle {
  metadata: Omit<SkillMetadata, "path">;
  files: SkillBundleFile[];
}

export function createJsonSkillFiles(
  name: string,
  description: string,
  content: string,
): SkillBundleFile[] {
  validateSkillName(name);
  validateSkillDescription(description);
  const markdown = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content.trim()}\n`;

  return [
    {
      path: SKILL_FILE,
      bytes: new TextEncoder().encode(markdown),
      contentType: "text/markdown; charset=utf-8",
    },
  ];
}

export async function createOrReplaceSkill(
  accountId: string,
  input: SkillBundleFile[],
): Promise<StoredSkill> {
  const { metadata, files } = validateSkillBundle(input);
  const skillPath = `${accountId}/${metadata.name}`;

  await deleteS3Prefix(skillsBucketName(), `${skillPath}/`);
  await Promise.all(
    files.map((file) =>
      writeS3Object(
        skillsBucketName(),
        `${skillPath}/${file.path}`,
        file.bytes,
        { contentType: file.contentType ?? contentTypeForSkillPath(file.path) },
      ),
    ),
  );

  return {
    ...metadata,
    path: skillPath,
    files: files.map((file) => ({
      path: file.path,
      size: file.bytes.byteLength,
    })),
  };
}

export async function deleteSkill(
  accountId: string,
  skillName: string,
): Promise<number> {
  validateSkillName(skillName);

  return deleteS3Prefix(skillsBucketName(), `${accountId}/${skillName}/`);
}

export async function fetchGitHubSkillFiles(
  url: unknown,
): Promise<SkillBundleFile[]> {
  const parsed = parseGitHubSkillUrl(url);
  const response = await fetch(parsed.archiveUrl, {
    headers: {
      "User-Agent": "broods-skill-importer",
      Accept: "application/x-gzip",
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download GitHub skill archive: ${response.status}`,
    );
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredBytes) &&
    declaredBytes > MAX_SKILL_ARCHIVE_BYTES
  ) {
    await response.body.cancel();
    throw new ClientError(
      `GitHub archive exceeds the ${MAX_SKILL_ARCHIVE_BYTES} byte limit`,
    );
  }

  // Not node:zlib: Convex's bundler rejects node builtins outside "use node" entry files.
  const decompressed = response.body.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const archive = await readCapped(decompressed, MAX_SKILL_ARCHIVE_BYTES);
  const subdirPrefix = parsed.subdir ? `${parsed.subdir}/` : "";
  const files: SkillBundleFile[] = [];
  for (const entry of parseTarFiles(archive)) {
    // Drop the archive's `<repo>-<ref>/` root directory.
    const relative = entry.path.split("/").slice(1).join("/");
    if (!relative || (subdirPrefix && !relative.startsWith(subdirPrefix))) {
      continue;
    }
    const bundlePath = normalizeBundlePath(
      subdirPrefix ? relative.slice(subdirPrefix.length) : relative,
    );
    files.push({
      path: bundlePath,
      bytes: entry.bytes,
      contentType: contentTypeForSkillPath(bundlePath),
    });
  }
  if (files.length === 0) {
    throw new ClientError("GitHub archive has no files at that path");
  }

  return files;
}

export async function getSkill(
  accountId: string,
  skillName: string,
): Promise<StoredSkill | null> {
  const metadata = await getSkillMetadata(accountId, skillName);
  if (!metadata) return null;
  const objects = await listS3Prefix(skillsBucketName(), `${metadata.path}/`);

  return {
    ...metadata,
    files: objects.map((object) => ({
      path: object.key.slice(`${metadata.path}/`.length),
      ...(object.size !== undefined ? { size: object.size } : {}),
    })),
  };
}

export async function listAccountSkills(
  accountId: string,
): Promise<SkillMetadata[]> {
  const objects = await listS3Prefix(skillsBucketName(), `${accountId}/`);
  const skillNames = new Set<string>();
  for (const object of objects) {
    const [, skillName] = object.key.split("/");
    if (skillName) {
      skillNames.add(skillName);
    }
  }

  const skills = await Promise.all(
    [...skillNames].map((skillName) =>
      getSkillMetadata(accountId, skillName).catch(() => null),
    ),
  );

  return skills.filter((skill): skill is SkillMetadata => skill !== null);
}

export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ClientError(`Download exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

export async function readSkillFileBytes(
  skillPath: string,
  filePath: string,
): Promise<Uint8Array> {
  return readS3Bytes(
    skillsBucketName(),
    `${skillPath}/${normalizeBundlePath(filePath)}`,
  );
}

export function skillsBucketName(): string {
  const bucket = process.env.SKILLS_BUCKET_NAME;
  if (!bucket) {
    throw new Error("SKILLS_BUCKET_NAME is required to store skills");
  }

  return bucket;
}

export function validateSkillBundle(
  input: SkillBundleFile[],
): ValidatedSkillBundle {
  const files = input.map((file) => ({
    ...file,
    path: normalizeBundlePath(file.path),
  }));
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new ClientError(`Duplicate skill file path: ${file.path}`);
    }
    seen.add(file.path);
    totalBytes += file.bytes.byteLength;
    if (file.bytes.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new ClientError(`Skill file is too large: ${file.path}`);
    }
    if (!isSupportedTextFile(file.path, file.bytes)) {
      throw new ClientError(
        `Skill file must be a supported text file: ${file.path}`,
      );
    }
  }
  if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
    throw new ClientError("Skill bundle exceeds 30 MB");
  }

  const skillFile = files.find((file) => file.path === SKILL_FILE);
  if (!skillFile) {
    throw new ClientError("Skill bundle must include SKILL.md at the root");
  }

  return {
    // Parsed from the head core reads, so a skill that uploads also lists.
    metadata: parseSkillMarkdown(
      new TextDecoder().decode(
        skillFile.bytes.subarray(0, MAX_SKILL_METADATA_BYTES),
      ),
    ),
    files: files,
  };
}

async function getSkillMetadata(
  accountId: string,
  skillName: string,
): Promise<SkillMetadata | null> {
  validateSkillName(skillName);
  const skillPath = `${accountId}/${skillName}`;
  const markdown = await readS3Text(
    skillsBucketName(),
    `${skillPath}/${SKILL_FILE}`,
  ).catch(() => null);
  if (markdown == null) return null;
  const metadata = parseSkillMarkdown(markdown);

  return { ...metadata, path: skillPath };
}

function isSupportedTextFile(filePath: string, bytes: Uint8Array): boolean {
  const dot = filePath.lastIndexOf(".");
  const extension = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  if (!TEXT_EXTENSIONS.has(extension)) {
    return false;
  }

  return !bytes.includes(0);
}

function parsePaxPath(content: string): string | null {
  let rest = content;
  while (rest.length > 0) {
    const space = rest.indexOf(" ");
    if (space < 0) {
      break;
    }
    const length = Number(rest.slice(0, space));
    if (!Number.isInteger(length) || length <= space + 1) {
      break;
    }
    const record = rest.slice(space + 1, length - 1);
    const equals = record.indexOf("=");
    if (equals >= 0 && record.slice(0, equals) === "path") {
      return record.slice(equals + 1);
    }
    rest = rest.slice(length);
  }

  return null;
}

// Tar typeflag "x" is a pax header whose `path` renames the next entry; "L" a GNU long name.
function parseTarFiles(
  archive: Uint8Array,
): Array<{ path: string; bytes: Uint8Array }> {
  const decoder = new TextDecoder();
  const entries: Array<{ path: string; bytes: Uint8Array }> = [];
  let overridePath: string | null = null;
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const size = parseInt(readTarString(decoder, header, 124, 12) || "0", 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const body = archive.subarray(offset + 512, offset + 512 + size);
    if (typeflag === "x") {
      overridePath = parsePaxPath(decoder.decode(body)) ?? overridePath;
    } else if (typeflag === "L") {
      overridePath = readTarString(decoder, body, 0, body.length);
    } else {
      if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
        const name = readTarString(decoder, header, 0, 100);
        const prefix = readTarString(decoder, header, 345, 155);
        entries.push({
          path: overridePath ?? (prefix ? `${prefix}/${name}` : name),
          bytes: body.slice(),
        });
      }
      overridePath = null;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function readTarString(
  decoder: TextDecoder,
  bytes: Uint8Array,
  start: number,
  length: number,
): string {
  const raw = decoder.decode(bytes.subarray(start, start + length));
  const nul = raw.indexOf("\0");

  return (nul >= 0 ? raw.slice(0, nul) : raw).trim();
}
