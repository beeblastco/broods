/**
 * Harness skill prompt loading for model context.
 * Keep account skill CRUD in account-manage and shared rules in _shared.
 */

import type { SystemModelMessage } from "ai";
import type { AgentConfig } from "../_shared/storage/index.ts";
import {
  assertAccountOwnsSkillPath,
  normalizeBundlePath,
  parseSkillMarkdown,
  parseSkillPath,
  readSkillMarkdown,
  readSkillText,
  skillInstructionsFromMarkdown,
  SKILL_FILE,
  type SkillMetadata,
} from "../_shared/skills.ts";

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
): Promise<{
  skillPath: string;
  loadedPaths: string[];
  bytes: number;
  prompt: SystemModelMessage;
}> {
  if (!allowedSkillPaths.includes(skillPath)) {
    throw new Error(`Skill is not configured for this agent: ${skillPath}`);
  }

  const loaded = await loadSkillContent(skillPath, resourcePaths);
  return {
    skillPath,
    loadedPaths: loaded.parts.map((part) => part.path),
    bytes: loaded.bytes,
    prompt: {
      role: "system",
      content: formatLoadedSkillPrompt(loaded),
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
        skillPath,
      });
    }
  }
  return enabled;
}

export async function loadSkillContent(skillPath: string, resourcePaths: string[] = []): Promise<{
  skillPath: string;
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
    skillPath,
    skill: {
      ...skill,
      skillPath,
    },
    parts,
    bytes: parts.reduce((total, part) => total + Buffer.byteLength(part.text, "utf-8"), 0),
  };
}

function formatLoadedSkillPrompt(loaded: Awaited<ReturnType<typeof loadSkillContent>>): string {
  const parts = loaded.parts.map((part) => `## ${part.path}\n\n${part.text.trim()}`).join("\n\n");
  // See https://github.com/microsoft/agent-framework/discussions/4239: loaded skills stay in
  // refreshed system instructions instead of polluting chat history.
  return `<loaded-skill path="${loaded.skillPath}" name="${loaded.skill.name}">
${parts}
</loaded-skill>`;
}
