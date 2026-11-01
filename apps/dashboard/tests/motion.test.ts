import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { MOTION_MS } from "../app/lib/motion";

const APP = new URL("../app/", import.meta.url).pathname;

// The rail's open-on-hover waits out its width transition (see sidebarRail.spec.ts).
const KNOWN = new Set(["components/ui/sidebar.tsx"]);

const LAYOUT_TRANSITION =
  /\btransition-all\b|\btransition-\[[^\]]*\b(?:width|height|inset|left|right|top|bottom|margin|padding)\b[^\]]*\]|\btransition(?:-property)?:[^;]*\b(?:all|width|height|inset|left|right|top|bottom|margin|padding)\b/;

test("MOTION_MS mirrors the duration tokens in globals.css", () => {
  const css = readFileSync(`${APP}globals.css`, "utf8");
  for (const [name, ms] of Object.entries(MOTION_MS)) {
    expect(css).toContain(`--transition-duration-${name}: ${ms}ms;`);
  }
});

test("nothing in app/ transitions a layout property", () => {
  const offenders = [...new Glob("**/*.{ts,tsx,css}").scanSync(APP)].filter(
    (file) =>
      !KNOWN.has(file) &&
      LAYOUT_TRANSITION.test(readFileSync(`${APP}${file}`, "utf8")),
  );
  expect(offenders).toEqual([]);
});
