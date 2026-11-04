import { describe, expect, test } from "bun:test";
import { draftChanges } from "../app/lib/dockSource";

describe("dock source", () => {
  test("a draft's changes are its adds, edits and deletes against the seed, by path", () => {
    expect(
      draftChanges(
        [
          { path: "broods/a.ts", content: "a" },
          { path: "broods/gone.ts", content: "x" },
          { path: "package.json", content: "{}" },
        ],
        [
          { path: "broods/a.ts", content: "b" },
          { path: "broods/new.ts", content: "n" },
          { path: "package.json", content: "{}" },
        ],
      ),
    ).toEqual([
      { path: "broods/a.ts", change: "modify", before: "a", after: "b" },
      { path: "broods/gone.ts", change: "delete", before: "x", after: "" },
      { path: "broods/new.ts", change: "add", before: "", after: "n" },
    ]);
  });
});
