// schema.ts and the CLI import this: no zod here, stageSourceSchema.ts holds the wire check.
import { sha256Hex } from "./accountSecrets";

/** What a stage's source may hold: its `broods/` folder plus the manifest it installs from. */
export const STAGE_SOURCE_LIMITS = {
  files: 400,
  bytes: 2_000_000,
  revisions: 20,
} as const;
export const STAGE_SOURCE_ROOT_FILES: readonly string[] = [
  "package.json",
  "bun.lock",
];
export const STAGE_SOURCE_ORIGINS = ["cli", "apply", "github"] as const;

const BUILD_FOLDERS: ReadonlySet<string> = new Set([
  "_generated",
  "build",
  "dist",
  "generated",
  "node_modules",
]);
const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|mjs|json|md|txt|ya?ml)$/;

export type StageSourceOrigin = (typeof STAGE_SOURCE_ORIGINS)[number];
export type StageSourceFile = { content: string; path: string };
export type StageSource = { files: StageSourceFile[]; commitSha?: string };

/** Text under `broods/` an agent may read and write: no dot, build or `..` segment. */
export function isSourceFile(path: string): boolean {
  return (
    !path
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          part === "" ||
          part.startsWith(".") ||
          BUILD_FOLDERS.has(part),
      ) && SOURCE_FILE_PATTERN.test(path)
  );
}

export function isStageSourcePath(path: string): boolean {
  return (
    STAGE_SOURCE_ROOT_FILES.includes(path) ||
    (path.startsWith("broods/") && isSourceFile(path))
  );
}

// Refusals name the file, so the CLI can say what to move out of `broods/`.
export function stageSourceProblem(
  files: readonly StageSourceFile[],
): string | null {
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (!isStageSourcePath(file.path))
      return `${file.path} is not a source file`;
    if (paths.has(file.path)) return `${file.path} is listed twice`;
    paths.add(file.path);
    bytes += new TextEncoder().encode(file.content).length;
  }
  if (files.length > STAGE_SOURCE_LIMITS.files)
    return `${files.length} files is over the ${STAGE_SOURCE_LIMITS.files} file limit`;
  if (bytes > STAGE_SOURCE_LIMITS.bytes)
    return `${bytes} bytes is over the ${STAGE_SOURCE_LIMITS.bytes} byte limit`;

  return null;
}

/** sha256 hex over the files by path, the content hash two revisions are compared by. */
export async function stageSourceHash(
  files: readonly StageSourceFile[],
): Promise<string> {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  return await sha256Hex(
    JSON.stringify(sorted.map((file) => [file.path, file.content])),
  );
}
