/**
 * Reports upstream releases for the dependencies whose types the repo builds on.
 * Exits 0 when current, 1 when a release is available, 2 when the check failed.
 */

import { readFile } from "node:fs/promises";

const REGISTRY = "https://registry.npmjs.org";

/** Watched outside the AI SDK family, where a caret bump is not automatic. */
const EXTRA_WATCHED = ["esbuild"];

const WORKSPACES = [
  "apps/core",
  "apps/dashboard",
  "apps/gateway",
  "packages/ai-sdk-sandbox",
  "packages/broods",
  "packages/convex",
];

interface Install {
  workspace: string;
  /** Undefined when the workspace has no resolvable copy on disk. */
  version: string | undefined;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  version?: string;
}

interface WatchedPackage {
  name: string;
  latest: string;
  /** Exact `ai` the latest release pins, when it pins one. */
  pinnedAi: string | undefined;
  installs: Install[];
}

try {
  const packages = await collectWatched();

  console.log(renderReport(packages));
  process.exit(packages.some(isStale) ? 1 : 0);
} catch (error) {
  // Exit 2 keeps a registry outage from reading as "everything is current".
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

async function collectWatched(): Promise<WatchedPackage[]> {
  const declaredIn = new Map<string, Set<string>>();

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
      const workspaces = declaredIn.get(name) ?? new Set<string>();
      workspaces.add(workspace);
      declaredIn.set(name, workspaces);
    }
  }

  const resolved = await Promise.all(
    [...declaredIn.keys()].sort().map(async (name) => {
      const workspaces = [...(declaredIn.get(name) ?? [])].sort();
      const [installs, latest] = await Promise.all([
        Promise.all(
          workspaces.map(async (workspace) => ({
            workspace: workspace,
            version: await readInstalledVersion(name, workspace),
          })),
        ),
        readLatest(name),
      ]);

      return {
        name: name,
        latest: latest.version,
        pinnedAi: latest.pinnedAi,
        installs: installs,
      };
    }),
  );

  return resolved;
}

/** Bun installs per workspace here, so each one is checked independently. */
async function readInstalledVersion(
  name: string,
  workspace: string,
): Promise<string | undefined> {
  for (const prefix of [`${workspace}/`, ""]) {
    const manifest = await readManifest(
      `${prefix}node_modules/${name}/package.json`,
    );
    if (manifest?.version) return manifest.version;
  }

  return undefined;
}

async function readLatest(
  name: string,
): Promise<{ version: string; pinnedAi: string | undefined }> {
  const response = await fetch(
    `${REGISTRY}/${name.replaceAll("/", "%2F")}/latest`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`${name}: registry returned ${response.status}`);
  }

  const manifest: unknown = await response.json();
  if (!isManifestWithVersion(manifest)) {
    throw new Error(`${name}: registry response has no version`);
  }
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

function isExact(range: string | undefined): range is string {
  return range !== undefined && /^\d+\.\d+\.\d+$/.test(range);
}

function isManifestWithVersion(
  value: unknown,
): value is PackageManifest & { version: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { version?: unknown }).version === "string"
  );
}

/** The one predicate the table and the exit status both read from. */
function isStale(entry: WatchedPackage): boolean {
  return entry.installs.some((install) => install.version !== entry.latest);
}

function isWatched(name: string): boolean {
  return (
    name === "ai" || name.startsWith("@ai-sdk/") || EXTRA_WATCHED.includes(name)
  );
}

/**
 * The family installs one copy of `ai` only when every pin agrees, so name the
 * single target rather than leaving N independent bumps to guess at.
 */
function renderLockstep(packages: WatchedPackage[]): string {
  const pins = new Map<string, string[]>();
  for (const entry of packages) {
    if (entry.pinnedAi === undefined) continue;
    pins.set(entry.pinnedAi, [...(pins.get(entry.pinnedAi) ?? []), entry.name]);
  }
  if (pins.size === 0) {
    return "No AI SDK package pins `ai` at an exact version.";
  }

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

function renderReport(packages: WatchedPackage[]): string {
  const stale = packages.filter(isStale);
  if (stale.length === 0) {
    return "All watched dependencies are current.";
  }

  const lines = [
    "| Package | Workspace | Installed | Latest | Pins `ai` |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const entry of stale) {
    for (const install of entry.installs) {
      if (install.version === entry.latest) continue;
      lines.push(
        `| \`${entry.name}\` | ${install.workspace} | ` +
          `${install.version ?? "not installed"} | ${entry.latest} | ` +
          `${entry.pinnedAi ?? "—"} |`,
      );
    }
  }

  return [...lines, "", renderLockstep(packages)].join("\n");
}
