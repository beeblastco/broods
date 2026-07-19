/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import { canonicalizeAgentSkillPaths } from "./configHttp";
import type { AgentConfig } from "./model/agentRules";

const ACCOUNT = "acct123" as Id<"accounts">;

describe("canonicalizeAgentSkillPaths", () => {
  test("prefixes bare skill names with the calling account id", () => {
    const config: AgentConfig = {
      skills: { enabled: true, allowed: ["gmail", "notion"] },
    };

    canonicalizeAgentSkillPaths(ACCOUNT, config);

    expect(config.skills?.allowed).toEqual(["acct123/gmail", "acct123/notion"]);
  });

  test("passes already-prefixed paths through unchanged", () => {
    const config: AgentConfig = {
      skills: { enabled: true, allowed: ["acct123/gmail", "other/gdrive"] },
    };

    canonicalizeAgentSkillPaths(ACCOUNT, config);

    // Ownership of "other/gdrive" is still rejected later by
    // validateAgentSkillPaths; canonicalization only fills in missing prefixes.
    expect(config.skills?.allowed).toEqual(["acct123/gmail", "other/gdrive"]);
  });

  test("tolerates configs without skills and undefined configs", () => {
    const config: AgentConfig = {};

    expect(() => canonicalizeAgentSkillPaths(ACCOUNT, config)).not.toThrow();
    expect(() => canonicalizeAgentSkillPaths(ACCOUNT, undefined)).not.toThrow();
    expect(config.skills).toBeUndefined();
  });
});
