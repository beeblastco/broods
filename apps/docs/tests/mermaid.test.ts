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

  test.each(
    diagrams.flatMap((diagram) =>
      WIDTHS.map((width) => ({
        name: `${diagram.location} at ${width}px`,
        source: diagram.source,
        width: width,
      })),
    ),
  )("$name", ({ source, width }): void => {
    const result = render(source, {
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
});

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
