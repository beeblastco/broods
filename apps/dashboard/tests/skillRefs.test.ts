import { describe, expect, test } from "bun:test";
import {
  includesSkillRef,
  matchesSkillRef,
  withoutSkillRef,
} from "../app/lib/skillRefs";

describe("skill ref matching", () => {
  test("matches a local skill path against an external account-qualified path", () => {
    expect(
      matchesSkillRef(
        "nx75a976t5jxpde36hw9xdc1wh87d3rp/greeting-skill",
        "greeting-skill",
      ),
    ).toBe(true);
  });

  test("includes accepts exact and trailing-segment refs", () => {
    expect(
      includesSkillRef(["other", "account/greeting-skill"], "greeting-skill"),
    ).toBe(true);
    expect(includesSkillRef(["other"], "greeting-skill")).toBe(false);
  });

  test("without removes matching exact and trailing-segment refs", () => {
    expect(
      withoutSkillRef(
        ["greeting-skill", "account/greeting-skill", "other"],
        "greeting-skill",
      ),
    ).toEqual(["other"]);
  });
});
