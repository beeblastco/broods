import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
// Convex loads a function's whole import graph on every call, and these run on every agent turn
// or request sign-in.
const HOT_ENTRIES = [
  "account/apiKeys.ts",
  "schema.ts",
  "runtime.ts",
  "runtimeIngress.ts",
  "runtimeLookups.ts",
  "usage.ts",
];
// The dashboard subscribes to these on every page; the sign-in is the one package they need.
const DASHBOARD_ENTRIES = [
  "access.ts",
  "dashboardReads.ts",
  "org/members.ts",
  "sandbox/auditEvents.ts",
  "sandbox/machines.ts",
  "user.ts",
];
const AUTH_PACKAGE = "@convex-dev/workos-authkit via auth.ts";
// `import x from "y"`, `export ... from "y"` and the side-effect `import "y"`; never `import type`.
const VALUE_IMPORT =
  /^(?:import|export)\s+(?!type\s)(?:[^;"]*?\sfrom\s+)?"([^"]+)"/gms;

describe("hot Convex modules", () => {
  test.each(HOT_ENTRIES)("%s imports no package but convex", (entry) => {
    expect(packageImports(entry)).toEqual([]);
  });

  test.each(DASHBOARD_ENTRIES)(
    "%s imports only convex and the sign-in",
    (entry) => {
      expect(packageImports(entry)).toEqual([AUTH_PACKAGE]);
    },
  );
});

// Every package but convex the entry reaches, as `package via importing file`.
function packageImports(entry: string): string[] {
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
        else if (!specifier.includes("_generated/"))
          found.push(`unresolved ${specifier} via ${relative(ROOT, file)}`);
      } else if (specifier !== "convex" && !specifier.startsWith("convex/")) {
        found.push(`${specifier} via ${relative(ROOT, file)}`);
      }
    }
  }

  return found;
}
