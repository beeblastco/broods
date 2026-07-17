/**
 * Skill bundle validation and S3 storage for the Convex config plane (epic #85
 * phase 9). A faithful port of core's `src/shared/skills.ts` rules and
 * `src/accounts/skills.ts` storage ops so bundles written here are readable by
 * core's harness skill loader. Node-runtime only — import exclusively from
 * `"use node"` actions.
 */

import {
  contentTypeForSkillPath,
  normalizeBundlePath,
  parseGitHubSkillUrl,
  parseSkillMarkdown,
  validateSkillDescription,
  validateSkillName,
  SKILL_FILE,
} from "./skillRules";
import {
  deleteS3Prefix,
  listS3Prefix,
  readS3Bytes,
  readS3Text,
  writeS3Object,
} from "./s3";

const MAX_SKILL_BUNDLE_BYTES = 30 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;

/**
 * One file inside a skill bundle upload.
 */
export interface SkillBundleFile {
  path: string;
  bytes: Uint8Array;
  contentType?: string;
}

/**
 * Skill identity parsed from SKILL.md plus its S3 path.
 */
export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
}

/**
 * A stored skill's metadata and file manifest.
 */
export interface StoredSkill extends SkillMetadata {
  files: Array<{ path: string; size?: number }>;
}

/**
 * Read the skills bucket name from the Convex deployment environment.
 * @returns the bucket name
 * @throws when SKILLS_BUCKET_NAME is not configured
 */
export function skillsBucketName(): string {
  const bucket = process.env.SKILLS_BUCKET_NAME;
  if (!bucket) {
    throw new Error("SKILLS_BUCKET_NAME is required to store skills");
  }

  return bucket;
}

/**
 * Validate a skill bundle and write it to S3, replacing any existing skill of
 * the same name. Mirrors core's `createOrReplaceSkill`.
 * @param accountId account id owning the skill (the S3 key prefix)
 * @param input bundle files to validate and store
 * @returns the stored skill's metadata and manifest
 * @throws when the bundle violates a validation rule
 */
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

/**
 * Load a stored skill's metadata and file manifest. Mirrors core's `getSkill`.
 * @param accountId account id owning the skill
 * @param skillName the skill name (without the account prefix)
 * @returns the stored skill, or null when it does not exist
 */
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

/**
 * List an account's stored skills' metadata. Mirrors core's `listAccountSkills`.
 * @param accountId account id owning the skills
 * @returns name/description/path for every readable skill
 */
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

/**
 * Load only SKILL.md metadata for list endpoints.
 * @param accountId account id owning the skill
 * @param skillName the skill name (without account prefix)
 * @returns metadata, or null when SKILL.md is missing or malformed
 */
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

/**
 * Delete a stored skill's objects.
 * @param accountId account id owning the skill
 * @param skillName the skill name
 * @returns the number of objects deleted
 */
export async function deleteSkill(
  accountId: string,
  skillName: string,
): Promise<number> {
  validateSkillName(skillName);

  return deleteS3Prefix(skillsBucketName(), `${accountId}/${skillName}/`);
}

/**
 * Read one stored skill file's raw bytes.
 * @param skillPath the `${accountId}/${skillName}` prefix
 * @param filePath the file path inside the skill
 * @returns the file contents
 */
export async function readSkillFileBytes(
  skillPath: string,
  filePath: string,
): Promise<Uint8Array> {
  return readS3Bytes(
    skillsBucketName(),
    `${skillPath}/${normalizeBundlePath(filePath)}`,
  );
}

/**
 * A validated skill bundle: parsed SKILL.md metadata plus normalized files.
 */
export interface ValidatedSkillBundle {
  metadata: Omit<SkillMetadata, "path">;
  files: SkillBundleFile[];
}

/**
 * Validate bundle paths, sizes, and text-file rules, and parse SKILL.md.
 * Mirrors core's `validateSkillBundle`.
 * @param input bundle files
 * @returns parsed metadata and normalized files
 * @throws when a rule is violated or SKILL.md is missing
 */
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
      throw new Error(`Duplicate skill file path: ${file.path}`);
    }
    seen.add(file.path);
    totalBytes += file.bytes.byteLength;
    if (file.bytes.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new Error(`Skill file is too large: ${file.path}`);
    }
    if (!isSupportedTextFile(file.path, file.bytes)) {
      throw new Error(`Skill file must be a supported text file: ${file.path}`);
    }
  }
  if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
    throw new Error("Skill bundle exceeds 30 MB");
  }

  const skillFile = files.find((file) => file.path === SKILL_FILE);
  if (!skillFile) {
    throw new Error("Skill bundle must include SKILL.md at the root");
  }

  return {
    metadata: parseSkillMarkdown(new TextDecoder().decode(skillFile.bytes)),
    files,
  };
}

/**
 * Build a JSON-source skill bundle: a single generated SKILL.md.
 * Mirrors core's `createJsonSkillFiles`.
 * @param name skill name
 * @param description skill description
 * @param content markdown skill instructions
 * @returns the single-file bundle
 */
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

/**
 * Download a GitHub tree URL's tarball and return the skill files under its
 * subdirectory. In-memory port of core's `createGitHubSkillFiles` (gunzip +
 * tar walk instead of Bun.Archive + tmpdir).
 * @param url GitHub tree URL (https://github.com/{owner}/{repo}/tree/{ref}/{path})
 * @returns the bundle files found under the URL's subdirectory
 * @throws when the download fails or the archive holds no files there
 */
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

  // Web-standard gunzip: Convex's bundler rejects node builtins (node:zlib)
  // outside "use node" entry files, and this model must stay importable.
  const decompressed = response.body.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const archive = new Uint8Array(
    await new Response(decompressed).arrayBuffer(),
  );
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
    throw new Error("GitHub archive has no files at that path");
  }

  return files;
}

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

/**
 * Check a bundle file is an allowed text type with no NUL bytes.
 * @param filePath the bundle-relative path
 * @param bytes the file contents
 * @returns true when the file is acceptable
 */
function isSupportedTextFile(filePath: string, bytes: Uint8Array): boolean {
  const dot = filePath.lastIndexOf(".");
  const extension = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  if (!TEXT_EXTENSIONS.has(extension)) {
    return false;
  }

  return !bytes.includes(0);
}

/**
 * Extract the regular files from an uncompressed tar archive, handling ustar
 * prefixes, pax `path` overrides, and GNU longname entries.
 * @param archive the uncompressed tar bytes
 * @returns the file entries with their full archive paths
 */
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

/**
 * Decode a NUL-terminated fixed-width tar header field.
 * @param decoder shared text decoder
 * @param bytes the header (or body) bytes
 * @param start field offset
 * @param length field width
 * @returns the decoded string up to the first NUL
 */
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

/**
 * Pull the `path` record out of a pax extended header body.
 * @param content the decoded pax header body ("len key=value\n" records)
 * @returns the path override, or null when the header has none
 */
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
