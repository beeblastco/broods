import type { HarnessAgentSkill } from "@ai-sdk/harness/agent";
import { MAX_CONFIGURED_SKILLS } from "@broods/convex/model/skillLimits";
import { MAX_SKILL_METADATA_BYTES } from "@broods/convex/model/skillRules";
import type { SystemModelMessage } from "ai";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { optionalEnv } from "../shared/env.ts";
import { logWarn } from "../shared/log.ts";
import {
  copyS3Object,
  deleteS3Object,
  ensureS3DirectoryMarkers,
  isMissingS3Error,
  listS3Prefix,
  readS3TextHead,
} from "../shared/s3.ts";
import { workspaceNamespacePrefix } from "../shared/sandbox.ts";
import {
  contentTypeForSkillPath,
  isExecutableSkillPath,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  normalizeBundlePath,
  parseOwnedSkillPath,
  parseSkillMarkdown,
  parseSkillPath,
  readSkillText,
  SKILL_FILE,
  skillInstructionsFromMarkdown,
  SkillNotFoundError,
  skillsBucketName,
  type SkillMetadata,
} from "../shared/skills.ts";

// Every load_skill re-stages a clean copy from the skills bucket, the source of truth.
const SKILL_CANONICAL_DIR = ".claude/skills";
const SKILL_MIRROR_DIRS = [".agents/skills"];
const SKILL_READ_CONCURRENCY = 8;

interface SkillBundleSandboxStage {
  stagedPath: string;
  mirrorPaths: string[];
  files: string[];
}

interface SkillSourceFile {
  key: string;
  path: string;
  size: number;
}

export type { SkillMetadata } from "../shared/skills.ts";

export async function listConfiguredSkillMetadata(
  accountId: string | undefined,
  agentConfig: AgentConfig,
): Promise<SkillMetadata[]> {
  if (!(agentConfig.skills?.enabled === true) || !accountId) {
    return [];
  }

  return listSkillMetadataForConfig(
    accountId,
    agentConfig.skills?.allowed ?? [],
  );
}

// Runs every turn, so it reads only each SKILL.md head; one that does not parse is skipped.
export async function listSkillMetadataForConfig(
  accountId: string,
  skillPaths: string[] = [],
): Promise<SkillMetadata[]> {
  const limit = skillReadLimit();
  const metadata = await Promise.all(
    ownedSkillPaths(accountId, skillPaths).map(
      async (skillPath): Promise<SkillMetadata | null> =>
        await readSkillOrSkip(
          skillPath,
          limit(() =>
            readS3TextHead(
              skillsBucketName(),
              `${skillPath}/${SKILL_FILE}`,
              MAX_SKILL_METADATA_BYTES,
            ),
          ).then((head) => ({ ...parseSkillMarkdown(head), path: skillPath })),
        ),
    ),
  );

  return metadata.filter((entry): entry is SkillMetadata => entry !== null);
}

// Each read is capped at its listed size, so a file grown after the listing stays in budget.
export async function loadConfiguredHarnessSkills(
  accountId: string | undefined,
  agentConfig: AgentConfig,
): Promise<HarnessAgentSkill[]> {
  if (!(agentConfig.skills?.enabled === true) || !accountId) {
    return [];
  }

  const limit = skillReadLimit();
  const listed = await Promise.all(
    ownedSkillPaths(accountId, agentConfig.skills.allowed ?? []).map(
      async (skillPath) => ({
        skillPath: skillPath,
        files: await limit(() => listSkillSourceFiles(skillPath)),
      }),
    ),
  );
  let totalBytes = 0;
  for (const { skillPath, files } of listed) {
    for (const file of files) {
      if (file.size > MAX_SKILL_FILE_BYTES) {
        throw new Error(
          `Skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${skillPath}/${file.path}`,
        );
      }
      totalBytes += file.size;
    }
  }
  if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
    throw new Error(
      `Configured harness skills exceed ${MAX_SKILL_BUNDLE_BYTES} bytes`,
    );
  }

  const loaded = await Promise.all(
    listed.map(
      async ({ skillPath, files }): Promise<HarnessAgentSkill | null> => {
        // listSkillSourceFiles sorts SKILL.md first.
        const [skillFile, ...resources] = files;
        if (skillFile?.path !== SKILL_FILE) {
          throw new SkillNotFoundError(skillPath);
        }
        const skillText = await readSkillOrSkip(
          skillPath,
          limit(() => readSkillText(skillPath, SKILL_FILE, skillFile.size)),
        );
        if (skillText === null) return null;
        const skill = parseSkillMarkdown(skillText);
        const resourceFiles = await Promise.all(
          resources.map(
            async (file): Promise<{ path: string; content: string }> => ({
              path: file.path,
              content: await limit(() =>
                readSkillText(skillPath, file.path, file.size),
              ),
            }),
          ),
        );

        return {
          name: skill.name,
          description: skill.description,
          content: skillInstructionsFromMarkdown(skillText),
          ...(resourceFiles.length > 0 ? { files: resourceFiles } : {}),
        };
      },
    ),
  );

  return loaded.filter((skill): skill is HarnessAgentSkill => skill !== null);
}

export async function loadConfiguredSkillPrompt(
  accountId: string | undefined,
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
  // `skills.allowed` is only checked to be strings, so ownership is enforced here.
  if (!accountId) {
    throw new Error("Skills require an account-scoped run");
  }
  parseOwnedSkillPath(accountId, skillPath);

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

export async function loadSkillContent(
  skillPath: string,
  resourcePaths: string[] = [],
): Promise<{
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
  const safeResourcePaths = [
    ...new Set(resourcePaths.map(normalizeBundlePath)),
  ].filter((resource) => resource !== SKILL_FILE);
  const limit = skillReadLimit();
  const resourceParts = await Promise.all(
    safeResourcePaths.map(async (resourcePath) => ({
      path: resourcePath,
      text: await limit(() => readSkillText(skillPath, resourcePath)),
    })),
  );
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
    parts: parts,
    bytes: parts.reduce(
      (total, part) => total + Buffer.byteLength(part.text, "utf-8"),
      0,
    ),
  };
}

function canonicalStagedPath(skillName: string): string {
  return `/${SKILL_CANONICAL_DIR}/${skillName}`;
}

function canonicalStagePrefix(
  workspaceNamespace: string,
  skillName: string,
): string {
  return `${workspaceNamespacePrefix(workspaceNamespace)}/${SKILL_CANONICAL_DIR}/${skillName}/`;
}

function compareSkillBundlePath(a: string, b: string): number {
  if (a === SKILL_FILE) return b === SKILL_FILE ? 0 : -1;
  if (b === SKILL_FILE) return 1;

  return a.localeCompare(b);
}

async function deleteStaleStagedSkillFiles(
  workspaceBucket: string,
  destinationPrefix: string,
  sourcePathSet: Set<string>,
): Promise<void> {
  const stagedObjects = await listS3Prefix(workspaceBucket, destinationPrefix);
  await Promise.all(
    stagedObjects.map(async (object) => {
      if (object.key.endsWith("/")) {
        return;
      }
      const relativePath = normalizeBundlePath(
        object.key.slice(destinationPrefix.length),
      );
      if (sourcePathSet.has(relativePath)) {
        return;
      }
      await deleteS3Object(workspaceBucket, object.key);
    }),
  );
}

function formatLoadedSkillPrompt(
  loaded: Awaited<ReturnType<typeof loadSkillContent>>,
  staged?: SkillBundleSandboxStage | null,
): string {
  const parts = loaded.parts
    .map((part) => `## ${part.path}\n\n${part.text.trim()}`)
    .join("\n\n");
  const mirrorText =
    staged && staged.mirrorPaths.length > 0
      ? ` It is also mirrored at ${staged.mirrorPaths.map((path) => `\`${path}\``).join(", ")} for tools that expect those locations.`
      : "";
  const sandboxText = staged
    ? `\n\n## Sandbox files\n\nThis skill's helper files are staged inside the current sandbox at \`${staged.stagedPath}\`. Run scripts from that path, for example \`bash ${staged.stagedPath}/script.sh\`, \`python3 ${staged.stagedPath}/script.py\`, or direct executable paths when the file has a shebang.${mirrorText}`
    : "\n\n## Sandbox files\n\nThe skill instructions are loaded. No sandbox staging path is available for bundled helper files in this turn, so bundled scripts are not available to execute.";

  return `<loaded-skill path="${loaded.path}" name="${loaded.skill.name}">
${parts}${sandboxText}
</loaded-skill>`;
}

async function listSkillSourceFiles(
  skillPath: string,
): Promise<SkillSourceFile[]> {
  const sourcePrefix = `${skillPath}/`;
  const objects = await listS3Prefix(skillsBucketName(), sourcePrefix);

  return objects
    .flatMap((object) => {
      if (object.key.endsWith("/")) {
        return [];
      }

      return [
        {
          key: object.key,
          path: normalizeBundlePath(object.key.slice(sourcePrefix.length)),
          size: object.size ?? MAX_SKILL_FILE_BYTES,
        },
      ];
    })
    .sort((a, b) => compareSkillBundlePath(a.path, b.path));
}

function mirrorStagedPaths(skillName: string): string[] {
  return SKILL_MIRROR_DIRS.map((dir) => `/${dir}/${skillName}`);
}

function mirrorStagePrefixes(
  workspaceNamespace: string,
  skillName: string,
): string[] {
  return SKILL_MIRROR_DIRS.map(
    (dir) =>
      `${workspaceNamespacePrefix(workspaceNamespace)}/${dir}/${skillName}/`,
  );
}

// A config saved before the config-time cap keeps running on its first MAX_CONFIGURED_SKILLS.
function ownedSkillPaths(accountId: string, skillPaths: string[]): string[] {
  const unique = [...new Set(skillPaths)];
  if (unique.length > MAX_CONFIGURED_SKILLS) {
    logWarn("Agent lists more skills than the limit; using the first ones", {
      accountId: accountId,
      skills: unique.length,
      limit: MAX_CONFIGURED_SKILLS,
    });
  }
  const used = unique.slice(0, MAX_CONFIGURED_SKILLS);
  for (const skillPath of used) parseOwnedSkillPath(accountId, skillPath);

  return used;
}

async function readSkillOrSkip<T>(
  skillPath: string,
  read: Promise<T>,
): Promise<T | null> {
  return read.catch((error: unknown) => {
    if (isMissingS3Error(error)) {
      throw new SkillNotFoundError(skillPath);
    }
    logWarn("Skipping a skill that could not be read", {
      skillPath: skillPath,
      error: error instanceof Error ? error.message : String(error),
    });

    return null;
  });
}

function skillReadLimit(): <T>(call: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async <T>(call: () => Promise<T>): Promise<T> => {
    if (active < SKILL_READ_CONCURRENCY) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await call();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
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

  await Promise.all(
    prefixes.map((prefix) =>
      stageSkillFiles(workspaceBucket, prefix, sourceFiles, sourcePathSet),
    ),
  );

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
  await deleteStaleStagedSkillFiles(
    workspaceBucket,
    destinationPrefix,
    sourcePathSet,
  );
  await Promise.all(
    sourceFiles.map(async (file) => {
      const destinationKey = `${destinationPrefix}${file.path}`;
      await ensureS3DirectoryMarkers(workspaceBucket, destinationKey);
      await copyS3Object(
        skillsBucketName(),
        file.key,
        workspaceBucket,
        destinationKey,
        {
          contentType: contentTypeForSkillPath(file.path),
          executable: isExecutableSkillPath(file.path),
        },
      );
    }),
  );
}
