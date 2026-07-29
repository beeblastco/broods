/**
 * Reports upstream releases for the dependencies whose types we build on.
 * The AI SDK family pins `ai` at an exact version inside its own packages, so
 * bumping one without the rest installs a second copy and breaks type identity.
 */

import { readFile } from "node:fs/promises";

const REGISTRY = "https://registry.npmjs.org";

/** Watched outside the AI SDK family, where a caret bump is not automatic. */
const EXTRA_WATCHED = ["esbuild"];

const WORKSPACES = [
  "apps/core",
  "apps/dashboard",
  "apps/gateway",
  "packages/broods",
  "packages/convex",
];

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  version?: string;
}

interface WatchedPackage {
  name: string;
  installed: string | undefined;
  latest: string | undefined;
  /** Exact `ai` the latest release pins, when it pins one. */
  pinnedAi: string | undefined;
  workspaces: string[];
}

const packages = await collectWatched();
const report = renderReport(packages);

console.log(report);
// A non-zero exit is the signal the workflow acts on, so keep it last.
process.exit(hasUpdates(packages) ? 1 : 0);

async function collectWatched(): Promise<WatchedPackage[]> {
  const seen = new Map<string, Set<string>>();

  for (const workspace of WORKSPACES) {
    const manifest = await readManifest(`${workspace}/package.json`);
    if (!manifest) continue;
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    for (const name of Object.keys(declared)) {
      if (!isWatched(name)) continue;
      const workspaces = seen.get(name) ?? new Set<string>();
      workspaces.add(workspace);
      seen.set(name, workspaces);
    }
  }

  const names = [...seen.keys()].sort();
  const resolved = await Promise.all(
    names.map(async (name) => {
      const workspaces = [...(seen.get(name) ?? [])].sort();
      const [installed, latest] = await Promise.all([
        readInstalledVersion(name, workspaces),
        readLatest(name),
      ]);

      return {
        name: name,
        installed: installed,
        latest: latest?.version,
        pinnedAi: latest?.pinnedAi,
        workspaces: workspaces,
      };
    }),
  );

  return resolved;
}

/** Bun installs per workspace here, so the root copy is only a fallback. */
async function readInstalledVersion(
  name: string,
  workspaces: string[],
): Promise<string | undefined> {
  for (const prefix of [...workspaces.map((w) => `${w}/`), ""]) {
    const manifest = await readManifest(
      `${prefix}node_modules/${name}/package.json`,
    );
    if (manifest?.version) return manifest.version;
  }

  return undefined;
}

async function readLatest(
  name: string,
): Promise<{ version: string; pinnedAi: string | undefined } | undefined> {
  const response = await fetch(
    `${REGISTRY}/${name.replace("/", "%2F")}/latest`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) return undefined;
  const manifest = (await response.json()) as PackageManifest & {
    version: string;
  };
  const pinnedAi =
    manifest.dependencies?.["ai"] ?? manifest.peerDependencies?.["ai"];

  return {
    version: manifest.version,
    pinnedAi: isExact(pinnedAi) ? pinnedAi : undefined,
  };
}

async function readManifest(
  path: string,
): Promise<PackageManifest | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

function hasUpdates(packages: WatchedPackage[]): boolean {
  return packages.some(
    (entry) =>
      entry.latest !== undefined &&
      entry.installed !== undefined &&
      entry.latest !== entry.installed,
  );
}

function isExact(range: string | undefined): range is string {
  return range !== undefined && /^\d+\.\d+\.\d+$/.test(range);
}

function isWatched(name: string): boolean {
  return name === "ai" || name.startsWith("@ai-sdk/") ||
    EXTRA_WATCHED.includes(name);
}

function renderReport(packages: WatchedPackage[]): string {
  const stale = packages.filter(
    (entry) => entry.latest !== entry.installed && entry.latest !== undefined,
  );
  if (stale.length === 0) return "All watched dependencies are current.";

  const lines = [
    "| Package | Installed | Latest | Pins `ai` | Workspaces |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const entry of stale) {
    lines.push(
      `| \`${entry.name}\` | ${entry.installed ?? "—"} | ${entry.latest} | ` +
        `${entry.pinnedAi ?? "—"} | ${entry.workspaces.join(", ")} |`,
    );
  }

  return [...lines, "", renderLockstep(packages)].join("\n");
}

/**
 * The family only installs one copy of `ai` when every pin agrees, so name the
 * single target version rather than leaving N independent bumps to guess at.
 */
function renderLockstep(packages: WatchedPackage[]): string {
  const pins = new Map<string, string[]>();
  for (const entry of packages) {
    if (entry.pinnedAi === undefined) continue;
    pins.set(entry.pinnedAi, [...(pins.get(entry.pinnedAi) ?? []), entry.name]);
  }
  if (pins.size === 0) return "No AI SDK package pins `ai` at an exact version.";

  const targets = [...pins.entries()];
  if (targets.length === 1) {
    const [version, names] = targets[0]!;

    return (
      `**Lockstep:** upgrade \`ai\` to \`${version}\` together with ` +
      `${names.map((name) => `\`${name}\``).join(", ")}. ` +
      "Bumping any of them alone installs a second copy of `ai` and breaks type identity."
    );
  }

  const conflict = targets
    .map(([version, names]) => `\`${version}\` (${names.join(", ")})`)
    .join(" vs ");

  return `**Conflict:** the latest releases disagree on \`ai\`: ${conflict}. Hold the upgrade until they converge.`;
}
