import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";
import { configuredMaxTurn } from "../../../../apps/core/src/shared/domain/agent-config.ts";
import { parseGitHubSkillUrl } from "../../../../apps/core/src/shared/skills.ts";

describe("configuredMaxTurn", (): void => {
  test("a limit is returned as set", (): void => {
    const config: AgentConfig = { agent: { maxTurn: 6 } };

    expect(configuredMaxTurn(config)).toBe(6);
  });

  test("zero means no limit", (): void => {
    const config: AgentConfig = { agent: { maxTurn: 0 } };

    expect(configuredMaxTurn(config)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("an agent with no limit set has none to report", (): void => {
    expect(configuredMaxTurn({})).toBeUndefined();
  });
});

describe("parseGitHubSkillUrl rejects unsafe path segments", (): void => {
  test.each<[string, string, string]>([
    ["owner", "https://github.com/bad!owner/repo/tree/main/skill", "owner"],
    ["repo", "https://github.com/owner/re$po/tree/main/skill", "repo"],
    ["ref", "https://github.com/owner/repo/tree/ma~in/skill", "ref"],
  ])("an unsupported character in the %s", (_label, url, segment): void => {
    expect((): unknown => parseGitHubSkillUrl(url)).toThrow(
      `GitHub ${segment} contains unsupported characters`,
    );
  });
});
