import { describe, expect, test } from "bun:test";
import { DASHBOARD_PANELS } from "../app/(main)/[projectId]/dashboard/panels";
import { SETTINGS_PANELS } from "../app/(main)/[projectId]/settings/panels";
import { ORG_PANELS } from "../app/(main)/settings/org/panels";
import { loadCanvas, loadCronsPage } from "../app/(main)/[projectId]/sections";
import {
  isPlainPress,
  isShallowRoute,
  sectionLoader,
  tabPanelLoader,
} from "../app/lib/routeIntent";

const PROJECT = "/px7818dqbhsjyrkjtdzjw7hfah8j0gcx";
const OTHER_PROJECT = "/mx74rpm315wj10h81pf9vf8z9n8hjhag";

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

describe("isShallowRoute", () => {
  test("a page of the open project", () => {
    expect(isShallowRoute(PROJECT, `${PROJECT}/scheduler`)).toBe(true);
    expect(
      isShallowRoute(`${PROJECT}/dashboard`, `${PROJECT}/settings?tab=keys`),
    ).toBe(true);
    expect(isShallowRoute(`${PROJECT}/sandbox`, PROJECT)).toBe(true);
  });

  test("a tab of the open page, in a project or not", () => {
    expect(isShallowRoute("/settings/org", "/settings/org?tab=members")).toBe(
      true,
    );
  });

  test("another project, an account page and an unknown page ask the server", () => {
    expect(isShallowRoute(PROJECT, `${OTHER_PROJECT}/scheduler`)).toBe(false);
    expect(isShallowRoute(PROJECT, "/projects")).toBe(false);
    expect(isShallowRoute("/projects", PROJECT)).toBe(false);
    expect(isShallowRoute("/settings/org", "/settings/account")).toBe(false);
    expect(isShallowRoute(PROJECT, `${PROJECT}/nope`)).toBe(false);
    expect(isShallowRoute(PROJECT, `${PROJECT}/dashboard/deeper`)).toBe(false);
  });
});

describe("sectionLoader", () => {
  test("names the chunk of a project page", () => {
    expect(sectionLoader(PROJECT)).toBe(loadCanvas);
    expect(sectionLoader(`${PROJECT}/scheduler?stage=x`)).toBe(loadCronsPage);
    expect(sectionLoader(`${PROJECT}/nope`)).toBeUndefined();
    expect(sectionLoader("/projects")).toBeUndefined();
  });
});
