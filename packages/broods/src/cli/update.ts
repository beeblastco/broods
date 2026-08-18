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

/** Compares release triples only: a prerelease of the version in hand is not an upgrade. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const left = releaseTriple(candidate);
  const right = releaseTriple(current);
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }

  return false;
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
 * Reads the install site off this module's own path: a global bun install lives
 * under `~/.bun/install/global`, and anything under the current project is a
 * dependency of that project rather than a copy on the PATH.
 */
export function updateTarget(): UpdateTarget {
  const self = fileURLToPath(import.meta.url);
  const bunGlobal = self.includes(`${sep}.bun${sep}install${sep}global${sep}`);
  const global =
    bunGlobal || !self.startsWith(`${resolve(process.cwd())}${sep}`);
  const manager = bunGlobal || (!global && hasBunLockfile()) ? "bun" : "npm";
  const verb = manager === "bun" ? "add" : "install";

  return {
    manager: manager,
    global: global,
    command: manager,
    args: global ? [verb, "-g", "broods@latest"] : [verb, "broods@latest"],
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

function hasBunLockfile(): boolean {
  const cwd = resolve(process.cwd());

  return (
    existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))
  );
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
