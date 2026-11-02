// The clause stops at the first quote or semicolon, so a miss never scans a multi-MB bundle.
const BARE_IMPORT_PATTERN =
  /(?:^|[\n;])\s*import\s+(?:[^;"'`]*?\s+from\s*)?["'](?!\.{1,2}\/|\/|node:)[^"']+["']|import\s*\(\s*["'](?!\.{1,2}\/|\/|node:)[^"']+["']\s*\)/;
const NODE_BUILTIN_IMPORT_PATTERN =
  /(?:import\s+(?:[^;"'`]*?\s+from\s*)?["']node:|import\s*\(\s*["']node:)/;
// Member reads only: bundled zod declares its own `process` key; `typeof process` is a probe.
const NODE_GLOBAL_MEMBER_PATTERN =
  /(?<![.\w$])(?:process|Buffer)\s*(?:\?\.|\.|\[)/;
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
// isolate/runner/web-globals.mjs installs no Web Streams, and every bundle importing `ai` uses one.
const WEB_STREAMS_PATTERN =
  /(?<![.\w$])(?:Readable|Writable|Transform)Stream\b/;

export function isWorkersSafeBundle(bundleSource: string): boolean {
  return ![...NODE_ONLY_PATTERNS, DYNAMIC_CODE_PATTERN].some(
    (pattern): boolean => pattern.test(bundleSource),
  );
}

export function isIsolateSafeBundle(bundleSource: string): boolean {
  return ![...NODE_ONLY_PATTERNS, WEB_STREAMS_PATTERN].some(
    (pattern): boolean => pattern.test(bundleSource),
  );
}
