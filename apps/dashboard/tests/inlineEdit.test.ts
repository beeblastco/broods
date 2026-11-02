import { describe, expect, test } from "bun:test";
import { resolveInlineEdit } from "../app/lib/inlineEdit";

describe("resolveInlineEdit", () => {
  test("commits the trimmed draft", () => {
    expect(resolveInlineEdit("  triage bot \n", "triage")).toEqual({
      kind: "commit",
      value: "triage bot",
    });
  });

  test("refuses a blank draft", () => {
    expect(resolveInlineEdit("", "triage")).toEqual({ kind: "empty" });
    expect(resolveInlineEdit(" \t ", "triage")).toEqual({ kind: "empty" });
  });

  test("the saved text again, padded or not, changes nothing", () => {
    expect(resolveInlineEdit("triage", "triage")).toEqual({
      kind: "unchanged",
    });
    expect(resolveInlineEdit("  triage ", "triage")).toEqual({
      kind: "unchanged",
    });
  });

  test("a change of case is a change", () => {
    expect(resolveInlineEdit("Triage", "triage")).toEqual({
      kind: "commit",
      value: "Triage",
    });
  });
});
