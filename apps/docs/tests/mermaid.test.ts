/**
 * Checks every docs diagram against the renderer used by the published site.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "pele";

const SITE_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const WIDTHS = [320, 768, 1280];

interface Diagram {
  location: string;
  source: string;
}

describe("docs diagrams", (): void => {
  const diagrams = readDiagrams();

  test("finds the docs' Mermaid blocks", (): void => {
    expect(diagrams.length).toBeGreaterThan(0);
  });

  for (const diagram of diagrams) {
    for (const width of WIDTHS) {
      test(`${diagram.location} at ${width}px`, (): void => {
        const result = render(diagram.source, {
          images: false,
          links: false,
          maxWidth: width,
        });

        expect(result.svg).toStartWith("<svg");
        expect(Number.isFinite(result.width)).toBe(true);
        expect(Number.isFinite(result.height)).toBe(true);
        expect(result.width).toBeGreaterThan(0);
        expect(result.height).toBeGreaterThan(0);
      });
    }
  }
});

/** Reads the real diagram sources so new docs are covered without a fixture copy. */
function readDiagrams(): Diagram[] {
  const diagrams: Diagram[] = [];
  const files = ["docs/**/*.{md,mdx}", "src/pages/**/*.{md,mdx}"].flatMap(
    (pattern): string[] => [
      ...new Glob(pattern).scanSync({
        cwd: SITE_DIRECTORY,
        onlyFiles: true,
      }),
    ],
  );

  for (const file of files.sort()) {
    const content = readFileSync(join(SITE_DIRECTORY, file), "utf8");
    const fences = content.matchAll(
      /^```mermaid[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm,
    );

    for (const fence of fences) {
      const line = content.slice(0, fence.index).split("\n").length;
      diagrams.push({
        location: `${file}:${line}`,
        source: fence[1],
      });
    }
  }

  return diagrams;
}
