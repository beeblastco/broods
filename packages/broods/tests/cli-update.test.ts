import { expect, test } from "bun:test";
import { isNewerVersion, updateTarget } from "../src/cli/update.ts";

/**
 * `broods update` and the notice on `broods dev` both hang off this comparison,
 * so an off-by-one here either nags on every sync or never offers the upgrade.
 */

test.each([
  ["0.15.2", "0.15.1", true],
  ["0.16.0", "0.15.9", true],
  ["1.0.0", "0.99.99", true],
  ["0.15.1", "0.15.1", false],
  ["0.15.0", "0.15.1", false],
  ["0.9.0", "0.10.0", false],
])("isNewerVersion(%s, %s) is %s", (candidate, current, expected) => {
  expect(isNewerVersion(candidate, current)).toBe(expected);
});

// A prerelease is published under the same triple, and offering it as "newer"
// would nag forever: installing `broods@latest` cannot land on it.
test("a prerelease of the version in hand is not an upgrade", () => {
  expect(isNewerVersion("0.15.1-rc.1", "0.15.1")).toBe(false);
  expect(isNewerVersion("v0.16.0-rc.1", "0.15.1")).toBe(true);
});

// The suite runs from a checkout, so this copy reads as a project dependency —
// the case where `-g` would install a second copy somewhere else entirely.
test("a copy inside the project upgrades the dependency, not a global", () => {
  const target = updateTarget();

  expect(target.global).toBe(false);
  expect(target.args).not.toContain("-g");
  expect(target.args).toContain("broods@latest");
});
