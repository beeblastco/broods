import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MOTION_MS } from "../app/lib/motion";

const APP = new URL("../app/", import.meta.url).pathname;

test("MOTION_MS mirrors the duration tokens in globals.css", () => {
  const css = readFileSync(`${APP}globals.css`, "utf8");
  for (const [name, ms] of Object.entries(MOTION_MS)) {
    expect(css).toContain(`--transition-duration-${name}: ${ms}ms;`);
  }
});

// TS and TSX are linted by broods/no-layout-transition; CSS is not.
test("globals.css transitions no layout property", () => {
  const css = readFileSync(`${APP}globals.css`, "utf8");
  expect(css).not.toMatch(
    /\btransition(?:-property)?:[^;]*\b(?:all|width|height|inset|left|right|top|bottom|margin|padding)\b/,
  );
});
