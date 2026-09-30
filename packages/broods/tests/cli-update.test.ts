import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { isNewerVersion, updateTarget } from "../src/cli/update.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

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

// `broods@latest` upgrades you off an rc but never onto one, so the rc is only
// ever the side that loses.
test("a stable release beats the prerelease of the same version", () => {
  expect(isNewerVersion("0.15.1", "0.15.1-rc.1")).toBe(true);
  expect(isNewerVersion("0.15.1-rc.1", "0.15.1")).toBe(false);
  expect(isNewerVersion("v0.16.0-rc.1", "0.15.1")).toBe(true);
});

// The suite runs from a checkout, so this copy reads as a project dependency,
// the case where `-g` would install a second copy somewhere else entirely.
test("a copy inside the project upgrades the dependency, not a global", () => {
  const target = updateTarget();

  expect(target.global).toBe(false);
  expect(target.args).not.toContain("-g");
  expect(target.args.at(-1)).toMatch(/^broods@\d+$/);
});

// A workspace runs the root-installed CLI from its own directory, which is not
// the directory the install lives in. Reading the project root off the caller
// instead of off `node_modules` would call that a global and install a second
// copy on the PATH.
test("a workspace still upgrades the root dependency", () => {
  const target = updateTarget(
    join(sep, "repo", "apps", "foo"),
    join(sep, "repo", "node_modules", "broods", "dist", "cli", "index.js"),
  );

  expect(target.global).toBe(false);
  expect(target.args).not.toContain("-g");
});

test.each([
  [
    "a global bun install",
    join(
      homedir(),
      ".bun",
      "install",
      "global",
      "node_modules",
      "broods",
      "dist",
      "cli",
      "index.js",
    ),
    "bun",
  ],
  [
    "a global npm install",
    join(
      sep,
      "usr",
      "local",
      "lib",
      "node_modules",
      "broods",
      "dist",
      "cli",
      "index.js",
    ),
    "npm",
  ],
])("%s replaces itself in place", (_label, self, manager) => {
  const target = updateTarget(join(sep, "somewhere", "else"), self);

  expect(target.global).toBe(true);
  expect(target.manager).toBe(manager);
  expect(target.args).toContain("-g");
});

// `broods@latest` crossed majors, so a 1.0 would have landed on a 0.x project.
test("the install stays on the running major", () => {
  const target = updateTarget(
    join(sep, "somewhere", "else"),
    join(
      sep,
      "usr",
      "lib",
      "node_modules",
      "broods",
      "dist",
      "cli",
      "index.js",
    ),
    "0.26.0",
  );

  expect(target.args).toEqual(["install", "-g", "broods@0"]);
});

test.each([
  ["pnpm-lock.yaml", "pnpm", ["add", "broods@1"]],
  ["yarn.lock", "yarn", ["add", "broods@1"]],
  ["bun.lock", "bun", ["add", "broods@1"]],
  ["package-lock.json", "npm", ["install", "broods@1"]],
])("a project with %s upgrades through %s", async (lockfile, manager, args) => {
  const root = await mkdtemp(join(tmpdir(), "broods-update-"));
  tempDirs.push(root);
  await writeFile(join(root, lockfile), "", "utf8");
  const self = join(root, "node_modules", "broods", "dist", "cli", "index.js");

  const target = updateTarget(root, self, "1.4.0");

  expect(target.manager).toBe(manager);
  expect(target.args).toEqual(args);
});

// pnpm and bun's isolated linker run the CLI from their store, which holds a
// second `node_modules`. Reading the root off that one called it a global.
test("a copy in pnpm's store upgrades the project through pnpm", async () => {
  const root = await mkdtemp(join(tmpdir(), "broods-update-"));
  tempDirs.push(root);
  await writeFile(join(root, "pnpm-lock.yaml"), "", "utf8");
  const self = join(
    root,
    "node_modules",
    ".pnpm",
    "broods@1.4.0",
    "node_modules",
    "broods",
    "dist",
    "cli",
    "index.js",
  );

  const target = updateTarget(root, self, "1.4.0");

  expect(target.manager).toBe("pnpm");
  expect(target.args).toEqual(["add", "broods@1"]);
});

// A workspace child running the root CLI must not add broods to its own
// manifest, and pnpm refuses a workspace-root add without `-w`.
test("a pnpm workspace updates the root dependency from the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "broods-update-"));
  tempDirs.push(root);
  await writeFile(join(root, "pnpm-lock.yaml"), "", "utf8");
  await writeFile(join(root, "pnpm-workspace.yaml"), "", "utf8");
  const self = join(root, "node_modules", "broods", "dist", "cli", "index.js");

  const target = updateTarget(join(root, "apps", "foo"), self, "1.4.0");

  expect(target.cwd).toBe(root);
  expect(target.args).toEqual(["add", "-w", "broods@1"]);
});
