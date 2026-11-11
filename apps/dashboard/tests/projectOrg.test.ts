import { describe, expect, test } from "bun:test";
import type { Id } from "@broods/convex/_generated/dataModel";
import { projectOrgGate } from "../app/lib/projectOrg";

const X = "org_x" as Id<"orgs">;
const Y = "org_y" as Id<"orgs">;

describe("project org gate", () => {
  test("a project of the active org shows its page", () => {
    expect(
      projectOrgGate({
        activeOrg: X,
        landed: true,
        projectOrg: X,
        refused: null,
      }),
    ).toEqual({ show: "page", switchTo: null });
  });

  test("another org's project waits for the first switch", () => {
    expect(
      projectOrgGate({
        activeOrg: Y,
        landed: false,
        projectOrg: X,
        refused: null,
      }),
    ).toEqual({ show: "wait", switchTo: X });
  });

  test("once switched, a later change of the active org keeps the page and switches back", () => {
    expect(
      projectOrgGate({
        activeOrg: Y,
        landed: true,
        projectOrg: X,
        refused: null,
      }),
    ).toEqual({ show: "page", switchTo: X });
  });

  test("a failed switch shows the refusal and stops switching", () => {
    expect(
      projectOrgGate({
        activeOrg: Y,
        landed: false,
        projectOrg: X,
        refused: X,
      }),
    ).toEqual({ show: "refused", switchTo: null });
  });
});
