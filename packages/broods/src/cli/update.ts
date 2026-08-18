/**
 * Version check against the npm registry, and the install command that matches
 * how this copy of the CLI was installed.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { USER_CONFIG_PATH } from "../config.ts";

const CACHE_PATH = join(dirname(USER_CONFIG_PATH), "update-check.json");
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = "https://registry.npmjs.org/broods/latest";
// A version check is never worth stalling a sync behind, so the fetch is capped
// well under the time a user would notice and a miss just skips the notice.
const REGISTRY_TIMEOUT_MS = 2_000;

/** Where this copy of the CLI lives, and therefore how to replace it. */
export interface UpdateTarget {
  manager: "bun" | "npm";
  /** False for a copy inside a project's node_modules, which `-g` must not touch. */
  global: boolean;
  /** Package manager binary to run. */
  command: string;
  /** Arguments that install the newest release over this copy. */
  args: string[];
}

interface CachedCheck {
  checkedAt: number;
  latest: string;
}

/**
 * Compares release triples, then treats a stable release as newer than the
 * prerelease of the same triple: `broods@latest` upgrades you off an rc but
 * never onto one, so an rc of the version in hand is not an upgrade.
 */
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

/**
 * Newest published version, cached in `~/.broods` for a day so the check on
 * every `broods dev` costs nothing. Null when the registry cannot be reached
 * and nothing was cached — a version check must never fail a command.
 */
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

/**
 * Reads the install site off this module's own path. The `node_modules` this
 * copy sits in names its project root, and the install belongs to that project
 * only when the caller is inside that root — so a workspace running the
 * root-installed CLI from `apps/foo` upgrades the dependency instead of
 * installing a second copy on the PATH. A checkout with no `node_modules` in
 * the path falls back to whether the caller is inside the checkout.
 */
export function updateTarget(
  cwd = resolve(process.cwd()),
  self = fileURLToPath(import.meta.url),
): UpdateTarget {
  const marker = `${sep}node_modules${sep}`;
  const markerAt = self.lastIndexOf(marker);
  const projectRoot = markerAt === -1 ? null : self.slice(0, markerAt);
  const local =
    projectRoot === null
      ? self.startsWith(`${cwd}${sep}`)
      : cwd === projectRoot || cwd.startsWith(`${projectRoot}${sep}`);
  const bunGlobal = self.includes(`${sep}.bun${sep}install${sep}global${sep}`);
  const manager =
    bunGlobal || (local && hasBunLockfile(projectRoot ?? cwd)) ? "bun" : "npm";
  const verb = manager === "bun" ? "add" : "install";

  return {
    manager: manager,
    global: !local,
    command: manager,
    args: local ? [verb, "broods@latest"] : [verb, "-g", "broods@latest"],
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

function hasBunLockfile(root: string): boolean {
  return (
    existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))
  );
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
    // A cache that cannot be written just means the next command re-checks.
  }
}
