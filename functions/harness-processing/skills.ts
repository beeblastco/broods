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
  listS3Prefix,
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
  type SkillMetadata,
} from "../_shared/skills.ts";

// Skills are re-staged fresh on every `load_skill`: the account skill bucket is the
// source of truth, and each load copies a clean read/run checkout into the workspace so
// the agent can execute bundled scripts in the sandbox. The canonical copy lives under
// `.claude/skills/<name>`; the same bundle is mirrored into SKILL_MIRROR_DIRS for tools
// that expect those industry-standard locations. Nothing is published back — staged
// edits are transient and overwritten by the next load.
const SKILL_CANONICAL_DIR = ".claude/skills";
const SKILL_MIRROR_DIRS = [".agents/skills"];

interface SkillBundleSandboxStage {
  stagedPath: string;
  mirrorPaths: string[];
  files: string[];
}

interface SkillSourceFile {
  key: string;
  path: string;
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
  const staged = workspaceNamespace
    ? await stageSkillBundleForSandbox(skillPath, workspaceNamespace)
    : null;
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
): Promise<SkillBundleSandboxStage | null> {
  const workspaceBucket = optionalEnv("FILESYSTEM_BUCKET_NAME");
  if (!workspaceBucket) return null;

  const parsed = parseSkillPath(skillPath);
  if (!parsed) {
    throw new Error(`Invalid skill path: ${skillPath}`);
  }

  const sourceFiles = await listSkillSourceFiles(skillPath);
  const sourcePathSet = new Set(sourceFiles.map((file) => file.path));
  const prefixes = [
    canonicalStagePrefix(workspaceNamespace, parsed.skillName),
    ...mirrorStagePrefixes(workspaceNamespace, parsed.skillName),
  ];

  // Refresh every staged location from source: drop stale files, copy the bundle in.
  await Promise.all(prefixes.map((prefix) =>
    stageSkillFiles(workspaceBucket, prefix, sourceFiles, sourcePathSet)));

  return {
    stagedPath: canonicalStagedPath(parsed.skillName),
    mirrorPaths: mirrorStagedPaths(parsed.skillName),
    files: sourceFiles.map((file) => file.path).sort(compareSkillBundlePath),
  };
}

async function stageSkillFiles(
  workspaceBucket: string,
  destinationPrefix: string,
  sourceFiles: SkillSourceFile[],
  sourcePathSet: Set<string>,
): Promise<void> {
  await ensureS3DirectoryMarkers(workspaceBucket, destinationPrefix);
  await deleteStaleStagedSkillFiles(workspaceBucket, destinationPrefix, sourcePathSet);
  await Promise.all(sourceFiles.map(async (file) => {
    const destinationKey = `${destinationPrefix}${file.path}`;
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
    return [{
      key: object.key,
      path: normalizeBundlePath(object.key.slice(sourcePrefix.length)),
    }];
  }).sort((a, b) => compareSkillBundlePath(a.path, b.path));
}

async function deleteStaleStagedSkillFiles(
  workspaceBucket: string,
  destinationPrefix: string,
  sourcePathSet: Set<string>,
): Promise<void> {
  const stagedObjects = await listS3Prefix(workspaceBucket, destinationPrefix);
  await Promise.all(stagedObjects.map(async (object) => {
    if (object.key.endsWith("/")) {
      return;
    }
    const relativePath = normalizeBundlePath(object.key.slice(destinationPrefix.length));
    if (sourcePathSet.has(relativePath)) {
      return;
    }
    await deleteS3Object(workspaceBucket, object.key);
  }));
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
    ? `\n\n## Sandbox files\n\nThis skill is checked out as a working copy in the workspace sandbox at \`${staged.stagedPath}\`. Run scripts from that path, for example \`bash ${staged.stagedPath}/script.sh\`, \`python3 ${staged.stagedPath}/script.py\`, or direct executable paths when the file has a shebang.${mirrorText}`
    : "\n\n## Sandbox files\n\nNo workspace sandbox path is available for this skill. Use the loaded instructions as read-only context; do not try to edit or execute bundled skill files.";
  // See https://github.com/microsoft/agent-framework/discussions/4239: loaded skills stay in
  // refreshed system instructions instead of polluting chat history.
  return `<loaded-skill path="${loaded.path}" name="${loaded.skill.name}">
${parts}${sandboxText}
</loaded-skill>`;
}
