/**
 * Static scan that keeps uploaded bundles off a tier that cannot run them.
 * The isolate (apps/core/src/harness/isolate/) exposes only the web-globals
 * set, with no node: builtins, no require(), no npm deps and no Web Streams, so
 * a bundle that reaches for any of those must be rejected at upload time
 * instead of dying with a ReferenceError at run time. Hooks are the one
 * remaining isolate tenant (#331 phase 3 sunset custom tools).
 */

// The `import ... from` clause stops at the first quote or semicolon, so a
// non-matching `import` never scans to the end of a multi-MB bundle.
const BARE_IMPORT_PATTERN =
  /(?:^|[\n;])\s*import\s+(?:[^;"'`]*?\s+from\s*)?["'](?!\.{1,2}\/|\/|node:)[^"']+["']|import\s*\(\s*["'](?!\.{1,2}\/|\/|node:)[^"']+["']\s*\)/;
const NODE_BUILTIN_IMPORT_PATTERN =
  /(?:import\s+(?:[^;"'`]*?\s+from\s*)?["']node:|import\s*\(\s*["']node:)/;
// Member reads only: a locally declared `process` method or export key is not
// the global (bundled zod ships one), and `typeof process` is a guarded probe.
const NODE_GLOBAL_MEMBER_PATTERN =
  /(?<![.\w$])(?:process|Buffer)\s*(?:\?\.|\.|\[)/;
// What only Node gives: require() and esbuild's __require shim, node:
// builtins, its globals, setImmediate, __dirname and unbundled package
// imports. Neither the isolate nor Workers have any of it.
const NODE_ONLY_PATTERNS = [
  /\b(?:__)?require\s*\(/,
  /(?<![.\w$])setImmediate\s*\(/,
  NODE_BUILTIN_IMPORT_PATTERN,
  NODE_GLOBAL_MEMBER_PATTERN,
  /\b__dirname\b/,
  BARE_IMPORT_PATTERN,
];
// Workers refuse code generation from strings.
const DYNAMIC_CODE_PATTERN = /(?<![.\w$])eval\s*\(|\bnew\s+Function\s*\(/;
// Web Streams are outside what isolate/runner/web-globals.mjs installs, so a
// bundle touching one cannot run there, and every bundle importing `ai` does.
const WEB_STREAMS_PATTERN =
  /(?<![.\w$])(?:Readable|Writable|Transform)Stream\b/;

/**
 * Whether a hosted MCP bundle can run on Cloudflare Dynamic Workers. The S3
 * bundle writer, which every upload path goes through, places rows by it, and
 * the CLI ships its Workers build only when that build passes it too.
 * @param bundleSource bundled JavaScript module source
 * @returns true when the bundle can run on Workers
 */
export function isWorkersSafeBundle(bundleSource: string): boolean {
  return ![...NODE_ONLY_PATTERNS, DYNAMIC_CODE_PATTERN].some(
    (pattern): boolean => pattern.test(bundleSource),
  );
}

/**
 * Cheap upload-time heuristic, not a proof.
 * @param bundleSource bundled JavaScript module source
 * @returns true when the bundle can run in the V8 isolate
 */
export function isIsolateSafeBundle(bundleSource: string): boolean {
  return ![...NODE_ONLY_PATTERNS, WEB_STREAMS_PATTERN].some(
    (pattern): boolean => pattern.test(bundleSource),
  );
}
