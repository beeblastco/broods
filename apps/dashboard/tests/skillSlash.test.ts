import { describe, expect, test } from "bun:test";
import {
  matchSkillSlashPrefix,
  parseSkillSlash,
  skillSlashMessage,
} from "../app/lib/skillSlash";

const ENABLED = ["reply-in-haiku", "import-tickets"];

describe("skill slash commands", () => {
  test("parses an enabled slash command with a payload", () => {
    expect(parseSkillSlash("/reply-in-haiku what is DNS?", ENABLED)).toEqual({
      name: "reply-in-haiku",
      rest: "what is DNS?",
    });
  });

  test("rejects names that are not enabled — one source of truth", () => {
    expect(parseSkillSlash("/other-skill hello", ENABLED)).toBeNull();
    expect(parseSkillSlash("plain message", ENABLED)).toBeNull();
  });

  test("autocomplete matches the typed prefix only while typing the token", () => {
    expect(matchSkillSlashPrefix("/", ENABLED)).toEqual(ENABLED);
    expect(matchSkillSlashPrefix("/rep", ENABLED)).toEqual(["reply-in-haiku"]);
    expect(matchSkillSlashPrefix("/reply-in-haiku hi", ENABLED)).toEqual([]);
  });

  test("expands into an explicit load-skill ask", () => {
    expect(
      skillSlashMessage({ name: "reply-in-haiku", rest: "what is DNS?" }),
    ).toBe('Load and follow your "reply-in-haiku" skill, then: what is DNS?');
    expect(skillSlashMessage({ name: "reply-in-haiku", rest: "" })).toBe(
      'Load and follow your "reply-in-haiku" skill, then confirm what it instructs you to do.',
    );
  });
});
