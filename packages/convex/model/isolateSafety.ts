/**
 * Static scan that keeps uploaded bundles off a tier that cannot run them.
 * The isolate (apps/core/src/harness/isolate/) exposes only the web-globals
 * set — no node: builtins, no require(), no npm deps, no Web Streams — so a
 * bundle that reaches for any of those must be rejected at upload time
 * instead of dying with a ReferenceError at run time. Hooks are the one
 * remaining isolate tenant (#331 phase 3 sunset custom tools).
 */

const BARE_IMPORT_PATTERN =
  /(?:^|[\n;])\s*import\s+(?:[\s\S]*?\s+from\s*)?["'](?!\.{1,2}\/|\/|node:)[^"']+["']|import\s*\(\s*["'](?!\.{1,2}\/|\/|node:)[^"']+["']\s*\)/;
const NODE_BUILTIN_IMPORT_PATTERN =
  /(?:import\s+(?:[\s\S]*?\s+from\s*)?["']node:|import\s*\(\s*["']node:)/;
// Member reads only: a locally declared `process` method or export key is not
// the global (bundled zod ships one), and `typeof process` is a guarded probe.
const NODE_GLOBAL_MEMBER_PATTERN =
  /(?<![.\w$])(?:process|Buffer)\s*(?:\?\.|\.|\[)/;
// Web Streams are outside what isolate/runner/web-globals.mjs installs, so a
// bundle touching one — every bundle importing `ai` does — cannot run there.
const WEB_STREAMS_PATTERN =
  /(?<![.\w$])(?:Readable|Writable|Transform)Stream\b/;

/**
 * Cheap upload-time heuristic: whether a bundle stays inside the isolate's
 * global set. Bundles that mention Node-only globals, node: imports,
 * require(), bare package imports, or Web Streams are not isolate-safe.
 * @param bundleSource bundled JavaScript module source
 * @returns true when the bundle can run in the V8 isolate
 */
export function isIsolateSafeBundle(bundleSource: string): boolean {
  return !(
    /\brequire\s*\(/.test(bundleSource) ||
    NODE_BUILTIN_IMPORT_PATTERN.test(bundleSource) ||
    NODE_GLOBAL_MEMBER_PATTERN.test(bundleSource) ||
    WEB_STREAMS_PATTERN.test(bundleSource) ||
    /\b__dirname\b/.test(bundleSource) ||
    BARE_IMPORT_PATTERN.test(bundleSource)
  );
}
