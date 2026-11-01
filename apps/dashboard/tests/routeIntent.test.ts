import { describe, expect, test } from "bun:test";
import { DASHBOARD_PANELS } from "../app/(main)/[projectId]/dashboard/panels";
import { SETTINGS_PANELS } from "../app/(main)/[projectId]/settings/panels";
import { ORG_PANELS } from "../app/(main)/settings/org/panels";
import { isPlainPress, tabPanelLoader } from "../app/lib/routeIntent";

const PRESS = {
  altKey: false,
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

describe("isPlainPress", () => {
  test("a left press with no modifier", () => {
    expect(isPlainPress(PRESS)).toBe(true);
  });

  test("middle and right presses keep the browser's behaviour", () => {
    expect(isPlainPress({ ...PRESS, button: 1 })).toBe(false);
    expect(isPlainPress({ ...PRESS, button: 2 })).toBe(false);
  });

  test("any modifier keeps the browser's behaviour", () => {
    for (const key of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(isPlainPress({ ...PRESS, [key]: true })).toBe(false);
    }
  });
});

describe("tabPanelLoader", () => {
  test("a project section's split tab, past the project id and the stage", () => {
    expect(tabPanelLoader("/p1/dashboard?stage=s1&tab=tracing")).toBe(
      DASHBOARD_PANELS.tracing,
    );
    expect(tabPanelLoader("/p1/settings?tab=variables&stage=s1")).toBe(
      SETTINGS_PANELS.variables,
    );
  });

  test("an account section's split tab, by its own path", () => {
    expect(tabPanelLoader("/settings/org?tab=members")).toBe(
      ORG_PANELS.members,
    );
  });

  test("nothing for a tab that ships with its page", () => {
    expect(tabPanelLoader("/p1/dashboard")).toBeUndefined();
    expect(tabPanelLoader("/p1/dashboard?tab=monitoring")).toBeUndefined();
    expect(tabPanelLoader("/p1/settings?stage=s1")).toBeUndefined();
  });

  test("nothing for a page without split tabs", () => {
    expect(tabPanelLoader("/p1")).toBeUndefined();
    expect(tabPanelLoader("/p1/scheduler?tab=tracing")).toBeUndefined();
    expect(tabPanelLoader("/projects")).toBeUndefined();
    expect(tabPanelLoader("/settings/account?tab=danger")).toBeUndefined();
  });
});
