import { describe, expect, test } from "bun:test";
import type { Exception } from "./audit-gate.ts";
import { judgeException } from "./dependency-watch.ts";

const TODAY = "2026-10-18";
const braces: Exception = {
  package: "braces",
  advisory: "GHSA-vfj7-8cjw-p6xm",
  expires: "2027-01-11",
  reason: "reviewed",
};

describe("judgeException", () => {
  test("reports a newer release as a fix candidate", () => {
    const rows = judgeException(braces, "3.0.3", "3.0.4", TODAY);
    expect(rows.map((row) => row.action)).toEqual([
      "exception fix candidate: braces 3.0.3 -> 3.0.4, delete the exception in scripts/audit-gate.ts after bumping",
    ]);
  });

  test("stays quiet while installed matches latest", () => {
    expect(judgeException(braces, "3.0.3", "3.0.3", TODAY)).toEqual([]);
  });

  test("ignores a package missing from the lock", () => {
    expect(judgeException(braces, undefined, "3.0.4", TODAY)).toEqual([]);
  });

  test("reports an exception expiring in 10 days", () => {
    const rows = judgeException(
      { ...braces, expires: "2026-10-28" },
      "3.0.3",
      "3.0.3",
      TODAY,
    );
    expect(rows.map((row) => row.action)).toEqual([
      "exception for braces expires 2026-10-28, re-review reachability or bump the date",
    ]);
  });
});
