/**
 * Harness skill prompt loading for model context.
 * Keep account skill CRUD in account-manage and shared rules in _shared.
 */

import type { SystemModelMessage } from "ai";
import { optionalEnv } from "../_shared/env.ts";
import { workspaceNamespacePrefix } from "../_shared/sandbox.ts";
import {
  copyS3Object,
  deleteS3Object,
  ensureS3DirectoryMarkers,
  isMissingS3Error,
  listS3Prefix,
  readS3Text,
  writeS3Object,
} from "../_shared/s3.ts";
import type { AgentConfig } from "../_shared/storage/index.ts";
import {
  assertAccountOwnsSkillPath,
  contentTypeForSkillPath,
  isExecutableSkillPath,
  normalizeBundlePath,
  parseSkillMarkdown,
  parseSkillPath,
  readSkillMarkdown,
  readSkillText,
  skillInstructionsFromMarkdown,
  skillsBucketName,
  SKILL_FILE,
  validateSkillBundle,
  type SkillBundleFile,
  type SkillMetadata,
} from "../_shared/skills.ts";

const SKILL_STAGE_MANIFEST_FILE = ".stage.json";

// Skills are staged like a git checkout: the account skill bucket is the source of
// truth ("origin"), each workspace clones a working copy, edits it, and publishes
// (pushes) back. The canonical working copy lives under `.claude/skills/<name>` and
// is what publish reads from. Mirror copies are also written to the directories in
// SKILL_MIRROR_DIRS so tools that look in other industry-standard locations still
// find the skill; they are read/exec conveniences, not the publish source.
const SKILL_CANONICAL_DIR = ".claude/skills";
const SKILL_MIRROR_DIRS = [".agents/skills"];

interface SkillBundleSandboxStage {
  stagedPath: string;
  mirrorPaths: string[];
  files: string[];
  copiedFiles: string[];
  deletedFiles: string[];
  cacheHit: boolean;
}

interface SkillStageManifest {
  version: 1;
  skillPath: string;
  stagedAt: string;
  files: SkillStageManifestFile[];
}

interface SkillStageManifestFile {
  path: string;
  sourceKey: string;
  etag?: string;
  size?: number;
}

interface SkillSourceFile extends SkillStageManifestFile {
  key: string;
}

export interface PublishedSkillFromWorkspace {
  path: string;
  files: Array<{ path: string; size: number }>;
  bytes: number;
}

export type { SkillMetadata } from "../_shared/skills.ts";

export async function listConfiguredSkillMetadata(
  accountId: string | undefined,
  agentConfig: AgentConfig,
): Promise<SkillMetadata[]> {
  if (!(agentConfig.skills?.enabled === true) || !accountId) {
    return [];
  }

  return listSkillMetadataForConfig(accountId, agentConfig.skills?.allowed ?? []);
}

export async function loadConfiguredSkillPrompt(
  allowedSkillPaths: string[],
  skillPath: string,
  resourcePaths: string[] = [],
  workspaceNamespace?: string,
  options: { preserveStagedEdits?: boolean } = {},
): Promise<{
  path: string;
  loadedPaths: string[];
  stagedPath?: string;
  stagedFiles: string[];
  bytes: number;
  prompt: SystemModelMessage;
}> {
  if (!allowedSkillPaths.includes(skillPath)) {
    throw new Error(`Skill is not configured for this agent: ${skillPath}`);
  }

  const loaded = await loadSkillContent(skillPath, resourcePaths);
  const staged = workspaceNamespace ? await stageSkillBundleForSandbox(
    skillPath,
    workspaceNamespace,
    { preserveStagedEdits: options.preserveStagedEdits !== false },
  ) : null;
  return {
    path: skillPath,
    loadedPaths: loaded.parts.map((part) => part.path),
    ...(staged ? { stagedPath: staged.stagedPath } : {}),
    stagedFiles: staged?.files ?? [],
    bytes: loaded.bytes,
    prompt: {
      role: "system",
      content: formatLoadedSkillPrompt(loaded, staged),
    },
  };
}

export async function publishStagedSkillBundle(
  allowedSkillPaths: string[],
  skillPath: string,
  workspaceNamespace: string,
  // Reads a directory (relative to the workspace namespace mount root) straight from
  // the sandbox mount. Publish must not read the working copy from S3: files the agent
  // wrote through the mount take ~1-2 min to sync into listable S3 objects (S3 Files is
  // eventually consistent), so an S3 read here would miss the agent's edits.
  readMountDir: (relativeDir: string) => Promise<Array<{ path: string; base64: string }>>,
  options: { force?: boolean } = {},
): Promise<PublishedSkillFromWorkspace> {
  if (!allowedSkillPaths.includes(skillPath)) {
    throw new Error(`Skill is not configured for this agent: ${skillPath}`);
  }

  const workspaceBucket = requireWorkspaceBucket();
  const parsed = parseSkillPath(skillPath);
  if (!parsed) {
    throw new Error(`Invalid skill path: ${skillPath}`);
  }

  const destinationPrefix = canonicalStagePrefix(workspaceNamespace, parsed.skillName);
  const manifest = await loadStageManifest(workspaceBucket, destinationPrefix);
  if (!manifest || manifest.skillPath !== skillPath) {
    throw new Error(`No staged skill checkout found for ${skillPath}. Load the skill with Workspace enabled before publishing changes.`);
  }

  const sourceFiles = await listSkillSourceFiles(skillPath);
  if (options.force !== true && !isStageCurrent(sourceFiles, manifest)) {
    throw new Error(`Source skill changed after checkout: ${skillPath}. Reload the skill before publishing, or publish with force.`);
  }

  const stagedFiles = (await readMountDir(`${SKILL_CANONICAL_DIR}/${parsed.skillName}`))
    .map((file) => ({ ...file, path: normalizeBundlePath(file.path) }))
    .filter((file) => file.path !== SKILL_STAGE_MANIFEST_FILE)
    .map((file): SkillBundleFile => ({
      path: file.path,
      bytes: Uint8Array.from(Buffer.from(file.base64, "base64")),
      contentType: contentTypeForSkillPath(file.path),
    }));
  const { metadata, files } = validateSkillBundle(stagedFiles);
  if (metadata.name !== parsed.skillName) {
    throw new Error(`Published SKILL.md name must remain ${parsed.skillName}`);
  }

  // Write the new bundle first, then delete only the source keys the published
  // bundle no longer contains. This keeps the source skill readable throughout
  // and never leaves it empty if a write fails partway.
  const sourcePrefix = `${skillPath}/`;
  const publishedPaths = new Set(files.map((file) => file.path));
  await Promise.all(files.map((file) => writeS3Object(
    skillsBucketName(),
    `${sourcePrefix}${file.path}`,
    file.bytes,
    { contentType: file.contentType ?? contentTypeForSkillPath(file.path) },
  )));
  await Promise.all(sourceFiles
    .filter((file) => !publishedPaths.has(file.path))
    .map((file) => deleteS3Object(skillsBucketName(), file.key)));

  return {
    path: skillPath,
    files: files.map((file) => ({ path: file.path, size: file.bytes.byteLength })),
    bytes: files.reduce((total, file) => total + file.bytes.byteLength, 0),
  };
}

export async function listSkillMetadataForConfig(accountId: string, skillPaths: string[] = []): Promise<SkillMetadata[]> {
  const enabled: SkillMetadata[] = [];
  for (const skillPath of skillPaths) {
    await assertAccountOwnsSkillPath(accountId, skillPath);
    const parsed = parseSkillPath(skillPath)!;
    const skillText = await readSkillMarkdown(accountId, parsed.skillName);
    if (skillText) {
      enabled.push({
        ...parseSkillMarkdown(skillText),
        path: skillPath,
      });
    }
  }
  return enabled;
}

export async function loadSkillContent(skillPath: string, resourcePaths: string[] = []): Promise<{
  path: string;
  skill: SkillMetadata;
  parts: Array<{ path: string; text: string }>;
  bytes: number;
}> {
  const parsed = parseSkillPath(skillPath);
  if (!parsed) {
    throw new Error(`Invalid skill path: ${skillPath}`);
  }

  const skillText = await readSkillText(skillPath, SKILL_FILE);
  const skill = parseSkillMarkdown(skillText);
  const safeResourcePaths = resourcePaths.map(normalizeBundlePath).filter((resource) => resource !== SKILL_FILE);
  const resourceParts = await Promise.all(safeResourcePaths.map(async (resourcePath) => ({
    path: resourcePath,
    text: await readSkillText(skillPath, resourcePath),
  })));
  const parts = [
    { path: SKILL_FILE, text: skillInstructionsFromMarkdown(skillText) },
    ...resourceParts,
  ];

  return {
    path: skillPath,
    skill: {
      ...skill,
      path: skillPath,
    },
    parts,
    bytes: parts.reduce((total, part) => total + Buffer.byteLength(part.text, "utf-8"), 0),
  };
}

async function stageSkillBundleForSandbox(
  skillPath: string,
  workspaceNamespace: string,
  options: { preserveStagedEdits: boolean },
): Promise<SkillBundleSandboxStage | null> {
  const workspaceBucket = optionalEnv("FILESYSTEM_BUCKET_NAME");
  if (!workspaceBucket) return null;

  const parsed = parseSkillPath(skillPath);
  if (!parsed) {
    throw new Error(`Invalid skill path: ${skillPath}`);
  }

  const destinationPrefix = canonicalStagePrefix(workspaceNamespace, parsed.skillName);
  const mirrorPrefixes = mirrorStagePrefixes(workspaceNamespace, parsed.skillName);
  const sourceFiles = await listSkillSourceFiles(skillPath);
  const manifest = await loadStageManifest(workspaceBucket, destinationPrefix);
  const files = sourceFiles.map((file) => file.path).sort(compareSkillBundlePath);

  if (options.preserveStagedEdits && manifest && isStageCurrent(sourceFiles, manifest)) {
    return {
      stagedPath: canonicalStagedPath(parsed.skillName),
      mirrorPaths: mirrorStagedPaths(parsed.skillName),
      files,
      copiedFiles: [],
      deletedFiles: [],
      cacheHit: true,
    };
  }

  const manifestByPath = new Map((manifest?.files ?? []).map((file) => [file.path, file]));
  const sourcePathSet = new Set(sourceFiles.map((file) => file.path));
  await ensureS3DirectoryMarkers(workspaceBucket, destinationPrefix);
  const deletedFiles = await deleteStaleStagedSkillFiles(workspaceBucket, destinationPrefix, sourcePathSet);
  const copiedFiles: string[] = [];

  await Promise.all(sourceFiles.map(async (file) => {
    const previous = manifestByPath.get(file.path);
    if (options.preserveStagedEdits && previous && manifestFileMatchesSource(previous, file)) {
      return;
    }

    const destinationKey = `${destinationPrefix}${file.path}`;
    await ensureS3DirectoryMarkers(workspaceBucket, destinationKey);
    await copyS3Object(skillsBucketName(), file.key, workspaceBucket, destinationKey, {
      contentType: contentTypeForSkillPath(file.path),
      executable: isExecutableSkillPath(file.path),
    });
    copiedFiles.push(file.path);
  }));

  // Mirror the account bundle into the other standard skill directories so
  // discovery tools find it there too. Mirrors always track the source bundle;
  // the canonical `.claude/skills` copy above is the editable, publishable one.
  await Promise.all(mirrorPrefixes.map((mirrorPrefix) =>
    syncMirrorSkillFiles(workspaceBucket, mirrorPrefix, sourceFiles, sourcePathSet)));

  copiedFiles.sort(compareSkillBundlePath);
  await writeStageManifest(workspaceBucket, destinationPrefix, {
    version: 1,
    skillPath,
    stagedAt: new Date().toISOString(),
    files: sourceFiles.map(({ path, sourceKey, etag, size }) => ({
      path,
      sourceKey,
      ...(etag ? { etag } : {}),
      ...(size !== undefined ? { size } : {}),
    })),
  });

  return {
    stagedPath: canonicalStagedPath(parsed.skillName),
    mirrorPaths: mirrorStagedPaths(parsed.skillName),
    files,
    copiedFiles,
    deletedFiles,
    cacheHit: false,
  };
}

async function syncMirrorSkillFiles(
  workspaceBucket: string,
  mirrorPrefix: string,
  sourceFiles: SkillSourceFile[],
  sourcePathSet: Set<string>,
): Promise<void> {
  await ensureS3DirectoryMarkers(workspaceBucket, mirrorPrefix);
  await deleteStaleStagedSkillFiles(workspaceBucket, mirrorPrefix, sourcePathSet);
  await Promise.all(sourceFiles.map(async (file) => {
    const destinationKey = `${mirrorPrefix}${file.path}`;
    await ensureS3DirectoryMarkers(workspaceBucket, destinationKey);
    await copyS3Object(skillsBucketName(), file.key, workspaceBucket, destinationKey, {
      contentType: contentTypeForSkillPath(file.path),
      executable: isExecutableSkillPath(file.path),
    });
  }));
}

async function listSkillSourceFiles(skillPath: string): Promise<SkillSourceFile[]> {
  const sourcePrefix = `${skillPath}/`;
  const objects = await listS3Prefix(skillsBucketName(), sourcePrefix);
  return objects.flatMap((object) => {
    if (object.key.endsWith("/")) {
      return [];
    }

    const relativePath = normalizeBundlePath(object.key.slice(sourcePrefix.length));
    return [{
      key: object.key,
      path: relativePath,
      sourceKey: object.key,
      ...(object.etag ? { etag: object.etag } : {}),
      ...(object.size !== undefined ? { size: object.size } : {}),
    }];
  }).sort((a, b) => compareSkillBundlePath(a.path, b.path));
}

async function loadStageManifest(
  workspaceBucket: string,
  destinationPrefix: string,
): Promise<SkillStageManifest | null> {
  try {
    const parsed = JSON.parse(await readS3Text(workspaceBucket, `${destinationPrefix}${SKILL_STAGE_MANIFEST_FILE}`));
    return isStageManifest(parsed) ? parsed : null;
  } catch (error) {
    if (isMissingS3Error(error)) {
      return null;
    }
    throw error;
  }
}

async function writeStageManifest(
  workspaceBucket: string,
  destinationPrefix: string,
  manifest: SkillStageManifest,
): Promise<void> {
  await writeS3Object(
    workspaceBucket,
    `${destinationPrefix}${SKILL_STAGE_MANIFEST_FILE}`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { contentType: "application/json" },
  );
}

async function deleteStaleStagedSkillFiles(
  workspaceBucket: string,
  destinationPrefix: string,
  sourcePathSet: Set<string>,
): Promise<string[]> {
  const stagedObjects = await listS3Prefix(workspaceBucket, destinationPrefix);
  const deleted: string[] = [];
  await Promise.all(stagedObjects.map(async (object) => {
    if (object.key.endsWith("/")) {
      return;
    }

    const relativePath = normalizeBundlePath(object.key.slice(destinationPrefix.length));
    if (relativePath === SKILL_STAGE_MANIFEST_FILE || sourcePathSet.has(relativePath)) {
      return;
    }

    await deleteS3Object(workspaceBucket, object.key);
    deleted.push(relativePath);
  }));

  return deleted.sort(compareSkillBundlePath);
}

function requireWorkspaceBucket(): string {
  const workspaceBucket = optionalEnv("FILESYSTEM_BUCKET_NAME");
  if (!workspaceBucket) {
    throw new Error("Workspace bucket is not configured");
  }
  return workspaceBucket;
}

function canonicalStagePrefix(workspaceNamespace: string, skillName: string): string {
  return `${workspaceNamespacePrefix(workspaceNamespace)}/${SKILL_CANONICAL_DIR}/${skillName}/`;
}

function mirrorStagePrefixes(workspaceNamespace: string, skillName: string): string[] {
  return SKILL_MIRROR_DIRS.map((dir) => `${workspaceNamespacePrefix(workspaceNamespace)}/${dir}/${skillName}/`);
}

function canonicalStagedPath(skillName: string): string {
  return `/${SKILL_CANONICAL_DIR}/${skillName}`;
}

function mirrorStagedPaths(skillName: string): string[] {
  return SKILL_MIRROR_DIRS.map((dir) => `/${dir}/${skillName}`);
}

function isStageCurrent(sourceFiles: SkillSourceFile[], manifest: SkillStageManifest): boolean {
  if (sourceFiles.length !== manifest.files.length) {
    return false;
  }

  const manifestByPath = new Map(manifest.files.map((file) => [file.path, file]));
  return sourceFiles.every((source) => {
    const manifestFile = manifestByPath.get(source.path);
    return manifestFile ? manifestFileMatchesSource(manifestFile, source) : false;
  });
}

function manifestFileMatchesSource(manifestFile: SkillStageManifestFile, sourceFile: SkillSourceFile): boolean {
  return manifestFile.sourceKey === sourceFile.sourceKey &&
    manifestFile.etag === sourceFile.etag &&
    manifestFile.size === sourceFile.size;
}

function isStageManifest(value: unknown): value is SkillStageManifest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SkillStageManifest>;
  return candidate.version === 1 &&
    typeof candidate.skillPath === "string" &&
    typeof candidate.stagedAt === "string" &&
    Array.isArray(candidate.files) &&
    candidate.files.every((file) =>
      file &&
      typeof file === "object" &&
      typeof (file as SkillStageManifestFile).path === "string" &&
      typeof (file as SkillStageManifestFile).sourceKey === "string"
    );
}

function compareSkillBundlePath(a: string, b: string): number {
  if (a === SKILL_FILE) return b === SKILL_FILE ? 0 : -1;
  if (b === SKILL_FILE) return 1;
  return a.localeCompare(b);
}

function formatLoadedSkillPrompt(
  loaded: Awaited<ReturnType<typeof loadSkillContent>>,
  staged?: SkillBundleSandboxStage | null,
): string {
  const parts = loaded.parts.map((part) => `## ${part.path}\n\n${part.text.trim()}`).join("\n\n");
  const mirrorText = staged && staged.mirrorPaths.length > 0
    ? ` It is also mirrored read-only at ${staged.mirrorPaths.map((path) => `\`${path}\``).join(", ")} for tools that expect those locations.`
    : "";
  const sandboxText = staged
    ? `\n\n## Sandbox files\n\nThis skill is checked out as an editable working copy in the workspace sandbox at \`${staged.stagedPath}\`. Edit files there and call publish_skill_changes to push them back to the account skill. Run scripts from that path, for example \`bash ${staged.stagedPath}/script.sh\`, \`python3 ${staged.stagedPath}/script.py\`, or direct executable paths when the file has a shebang.${mirrorText}`
    : "\n\n## Sandbox files\n\nNo workspace sandbox path is available for this skill. Use the loaded instructions as read-only context; do not try to edit or execute bundled skill files.";
  // See https://github.com/microsoft/agent-framework/discussions/4239: loaded skills stay in
  // refreshed system instructions instead of polluting chat history.
  return `<loaded-skill path="${loaded.path}" name="${loaded.skill.name}">
${parts}${sandboxText}
</loaded-skill>`;
}
