import { describe, expect, test } from "bun:test";
import { judgeAudit, type Exception } from "./audit-gate.ts";

const TODAY = "2026-10-11";
const braces: Exception = {
  package: "braces",
  advisory: "GHSA-vfj7-8cjw-p6xm",
  expires: "2027-01-11",
  reason: "reviewed",
};
const report = (severity: string) =>
  JSON.stringify({
    braces: [
      {
        url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
        title: "braces DoS",
        severity: severity,
        vulnerable_versions: "<=3.0.3",
      },
    ],
  });

describe("judgeAudit fails closed when the audit did not run", () => {
  test.each([
    ["registry error body", 0, '{"error":"x"}'],
    ["registry error object", 0, '{"error":{"status":500}}'],
    ["null", 0, "null"],
    ["not JSON", 1, "error: GET https://registry.npmjs.org/... 503"],
    ["empty map with an advisory exit", 1, "{}"],
    ["advisories with a crash exit", 2, report("high")],
    ["unknown severity", 1, report("urgent")],
  ])("%s", (_, exitCode, stdout) => {
    expect(judgeAudit(exitCode, stdout, [], TODAY).code).toBe(2);
  });
});

describe("judgeAudit", () => {
  test("passes a clean audit", () => {
    expect(judgeAudit(0, "{}", [], TODAY).code).toBe(0);
  });

  test("passes moderate and low advisories", () => {
    expect(judgeAudit(1, report("moderate"), [], TODAY).code).toBe(0);
  });

  test("fails an unreviewed high advisory", () => {
    expect(judgeAudit(1, report("high"), [], TODAY).code).toBe(1);
  });

  test("passes a high advisory with an unexpired exception", () => {
    expect(judgeAudit(1, report("critical"), [braces], TODAY).code).toBe(0);
  });

  test("fails once the exception expires", () => {
    expect(judgeAudit(1, report("high"), [braces], "2027-01-12").code).toBe(1);
  });

  test("fails an exception the audit no longer reports", () => {
    expect(judgeAudit(0, "{}", [braces], TODAY).code).toBe(1);
  });
});
