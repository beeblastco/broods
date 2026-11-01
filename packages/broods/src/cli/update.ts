import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { USER_CONFIG_PATH } from "../config.ts";
import packageJson from "../../package.json" with { type: "json" };

const CACHE_PATH = join(dirname(USER_CONFIG_PATH), "update-check.json");
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = "https://registry.npmjs.org/broods/latest";
// A version check never stalls a sync: past this the notice is just skipped.
const REGISTRY_TIMEOUT_MS = 2_000;
// First match wins, so a project that holds two lockfiles picks the same one each run.
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

export interface UpdateTarget {
  manager: PackageManager;
  global: boolean;
  command: string;
  /** The project root for a project install, so a workspace child's manifest is untouched. */
  cwd: string;
  args: string[];
}

interface CachedCheck {
  checkedAt: number;
  latest: string;
}

// A stable release beats its own prerelease: `broods@latest` takes you off an rc, never onto one.
export function isNewerVersion(candidate: string, current: string): boolean {
  const left = releaseTriple(candidate);
  const right = releaseTriple(current);
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }

  return !isPrerelease(candidate) && isPrerelease(current);
}

// Cached for a day so the check on every `broods dev` is free. Never throws.
export async function latestPublishedVersion(
  options: { maxAgeMs?: number } = {},
): Promise<string | null> {
  const cached = await readCachedCheck();
  const maxAge = options.maxAgeMs ?? CACHE_MAX_AGE_MS;
  if (cached && Date.now() - cached.checkedAt < maxAge) return cached.latest;
  const fetched = await fetchLatestVersion();
  if (fetched === null) return cached?.latest ?? null;
  await writeCachedCheck({ checkedAt: Date.now(), latest: fetched });

  return fetched;
}

export function majorVersion(version: string): number {
  return releaseTriple(version)[0] ?? 0;
}

// The first `node_modules` in this module's path is the project root, even in pnpm's and bun's
// isolated stores. From inside that root, update upgrades the dependency instead of putting a
// second copy on the PATH. It stays on the running major: a new one can break the project.
export function updateTarget(
  cwd = resolve(process.cwd()),
  self = fileURLToPath(import.meta.url),
  version = packageJson.version,
): UpdateTarget {
  const marker = `${sep}node_modules${sep}`;
  const markerAt = self.indexOf(marker);
  const projectRoot = markerAt === -1 ? null : self.slice(0, markerAt);
  const local =
    projectRoot === null
      ? self.startsWith(`${cwd}${sep}`)
      : cwd === projectRoot || cwd.startsWith(`${projectRoot}${sep}`);
  const bunGlobal = self.includes(`${sep}.bun${sep}install${sep}global${sep}`);
  const root = projectRoot ?? cwd;
  const manager: PackageManager = local
    ? lockfileManager(root)
    : bunGlobal
      ? "bun"
      : "npm";
  const verb = manager === "npm" ? "install" : "add";
  // pnpm refuses to add to a workspace root without `-w`.
  const rootFlag =
    manager === "pnpm" && existsSync(join(root, "pnpm-workspace.yaml"))
      ? ["-w"]
      : [];
  // `broods@0` is the X-range `^0`, spelled without the caret cmd.exe eats.
  const spec = `broods@${majorVersion(version)}`;

  return {
    manager: manager,
    global: !local,
    command: manager,
    cwd: local ? root : cwd,
    args: local ? [verb, ...rootFlag, spec] : [verb, "-g", spec],
  };
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const manifest = (await response.json()) as { version?: unknown };

    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

function isPrerelease(version: string): boolean {
  return version.includes("-");
}

async function readCachedCheck(): Promise<CachedCheck | null> {
  try {
    const cached = JSON.parse(
      await readFile(CACHE_PATH, "utf8"),
    ) as Partial<CachedCheck>;
    if (typeof cached.latest !== "string") return null;
    if (typeof cached.checkedAt !== "number") return null;

    return { checkedAt: cached.checkedAt, latest: cached.latest };
  } catch {
    return null;
  }
}

function lockfileManager(root: string): PackageManager {
  const match = LOCKFILES.find(([file]) => existsSync(join(root, file)));

  return match?.[1] ?? "npm";
}

function releaseTriple(version: string): number[] {
  const [release] = version.trim().replace(/^v/, "").split("-");

  return (release ?? "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

async function writeCachedCheck(check: CachedCheck): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, `${JSON.stringify(check)}\n`, "utf8");
  } catch {
    // An unwritable cache only means the next command re-checks.
  }
}
