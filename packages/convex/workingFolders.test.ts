/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  withWorkingFolder,
  withoutWorkingFolder,
} from "./model/workingFolders";

const EXTRA = {
  provider: { vertex: { apiKey: "${VERTEX_API_KEY}" } },
  scheduler: { enabled: true },
  skills: { allowed: ["acct/skill-a"] },
  publicAccess: false,
};

describe("working-folder config transforms (narrow-and-add invariant)", () => {
  test("attach appends the ref + sandbox and preserves every other branch", () => {
    const next = withWorkingFolder(
      EXTRA,
      { name: "desk", workspaceId: "q57abc" },
      "q17sbx",
    );
    expect(next.workspaces).toEqual([{ name: "desk", workspaceId: "q57abc" }]);
    expect(next.sandbox).toBe("q17sbx");
    expect(next.scheduler).toEqual({ enabled: true });
    expect(next.skills).toEqual({ allowed: ["acct/skill-a"] });
    expect(next.provider).toEqual(EXTRA.provider);
    expect(next.publicAccess).toBe(false);
  });

  test("attach never drops an existing folder", () => {
    const withOne = withWorkingFolder(
      EXTRA,
      { name: "a", workspaceId: "w1" },
      "sb1",
    );
    const withTwo = withWorkingFolder(
      withOne,
      { name: "b", workspaceId: "w2" },
      "sb1",
    );
    expect(withTwo.workspaces).toEqual([
      { name: "a", workspaceId: "w1" },
      { name: "b", workspaceId: "w2" },
    ]);
  });

  test("detach removes exactly the named folder and nothing else", () => {
    const both = withWorkingFolder(
      withWorkingFolder(EXTRA, { name: "a", workspaceId: "w1" }, "sb1"),
      { name: "b", workspaceId: "w2" },
      "sb1",
    );
    const next = withoutWorkingFolder(both, "w1");
    expect(next.workspaces).toEqual([{ name: "b", workspaceId: "w2" }]);
    // The sandbox and every unrelated branch survive the removal.
    expect(next.sandbox).toBe("sb1");
    expect(next.scheduler).toEqual({ enabled: true });
    expect(next.skills).toEqual({ allowed: ["acct/skill-a"] });
  });

  test("detaching the last folder clears the list but keeps the machine", () => {
    const one = withWorkingFolder(
      EXTRA,
      { name: "a", workspaceId: "w1" },
      "sb1",
    );
    const next = withoutWorkingFolder(one, "w1");
    expect(next.workspaces).toBeUndefined();
    expect(next.sandbox).toBe("sb1");
  });
});
