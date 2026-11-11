import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
// Convex loads a function's whole import graph on every call, and these run on every agent turn.
const HOT_ENTRIES = [
  "schema.ts",
  "runtime.ts",
  "runtimeIngress.ts",
  "runtimeLookups.ts",
  "usage.ts",
];
const HEAVY_PACKAGES = ["zod", "convex-helpers"];
const VALUE_IMPORT =
  /^(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s+"([^"]+)"/gms;

describe("hot Convex modules", () => {
  test.each(HOT_ENTRIES)("%s loads no schema library", (entry) => {
    expect(heavyImports(entry)).toEqual([]);
  });
});

// Every heavy package the entry reaches, as `package via importing file`.
function heavyImports(entry: string): string[] {
  const seen = new Set<string>([join(ROOT, entry)]);
  const found: string[] = [];
  for (const file of seen) {
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(
      VALUE_IMPORT,
    )) {
      if (!specifier) continue;
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        const path = [`${target}.ts`, join(target, "index.ts")].find(
          existsSync,
        );
        if (path) seen.add(path);
      } else if (
        HEAVY_PACKAGES.some(
          (name) => specifier === name || specifier.startsWith(`${name}/`),
        )
      ) {
        found.push(`${specifier} via ${relative(ROOT, file)}`);
      }
    }
  }

  return found;
}
