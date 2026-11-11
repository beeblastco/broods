import { expect, test } from "bun:test";
import { isValidSkillName } from "@broods/convex/model/skillRules";

test("the skill form accepts and refuses names as Convex does", () => {
  expect(isValidSkillName("support-flow")).toBe(true);
  expect(isValidSkillName("my-skill-")).toBe(true);
  expect(isValidSkillName("-draft")).toBe(true);
  expect(isValidSkillName("claude-helper")).toBe(false);
  expect(isValidSkillName("anthropic-tools")).toBe(false);
  expect(isValidSkillName("a".repeat(65))).toBe(false);
  expect(isValidSkillName("")).toBe(false);
});
