import { describe, expect, test } from "bun:test";
import type { Id } from "@broods/convex/_generated/dataModel";
import { dashboardHref } from "../app/(main)/[projectId]/sandbox/components/sandboxFormat";

const PROJECT_ID = "proj_1" as Id<"projects">;

describe("dashboardHref", () => {
  test("keeps the stage the page is on ahead of the deep-link params", () => {
    expect(
      dashboardHref(PROJECT_ID, "staging", { tab: "tracing", trace: "abc" }),
    ).toBe("/proj_1/dashboard?stage=staging&tab=tracing&trace=abc");
  });

  test("omits the stage when the page has none", () => {
    expect(dashboardHref(PROJECT_ID, null, { tab: "monitoring" })).toBe(
      "/proj_1/dashboard?tab=monitoring",
    );
  });
});
