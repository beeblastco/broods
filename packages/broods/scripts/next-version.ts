/**
 * Derives the next SDK version from the conventional-commit subjects landed
 * since the last release. `--write` applies it to package.json and the root
 * bun.lock (frozen installs check the workspace version, so both move
 * together). Prints one JSON line either way; `bump: "none"` means no commit
 * since the last release touched the package.
 *
 * The anchor is the newest `broods-v*` tag, which the publish workflow cuts on
 * the commit it published. Nothing writes a bump back to `dev`, so the version
 * in package.json is the last released one at best and stale at worst; asking
 * the tags is asking what actually shipped.
 */

const PACKAGE_PATH = "packages/broods/package.json";
const LOCK_PATH = "bun.lock";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const BREAKING = /^[a-z]+(\([^)]*\))?!:/;
const FEATURE = /^feat(\([^)]*\))?:/;

type Bump = "major" | "minor" | "patch" | "none";

const write = process.argv.includes("--write");
// Every path here is repo-relative, so git and the file writes agree no matter
// which workspace the script was invoked from.
process.chdir(git(["rev-parse", "--show-toplevel"]));

// What the file says, and what actually shipped. They are the same until a
// release lands without a bump commit, and from then on only the tag is right.
const declared = JSON.parse(await Bun.file(PACKAGE_PATH).text())
  .version as string;
const released = lastReleaseTag();
const current = released?.version ?? declared;
const parsed = SEMVER.exec(current);
if (!parsed) throw new Error(`Cannot bump a non-semver version: ${current}`);

const major = Number(parsed[1]);
const minor = Number(parsed[2]);
const patch = Number(parsed[3]);
const since = released?.tag ?? lastBumpCommit();
const subjects = git([
  "log",
  "--no-merges",
  "--format=%s",
  ...(since ? [`${since}..HEAD`] : []),
  "--",
  "packages/broods",
])
  .split("\n")
  .filter(Boolean);

const bump = classify(subjects);
const next = bump === "none" ? current : nextVersion(bump);

if (write && bump !== "none") {
  // Textual edits, not a re-serialize: bun.lock is JSONC, and rewriting
  // package.json through JSON.stringify would churn its whole formatting.
  // Replace what the files literally hold, which is `declared`, not the tag.
  await replace(
    PACKAGE_PATH,
    `"version": "${declared}"`,
    `"version": "${next}"`,
  );
  await replace(
    LOCK_PATH,
    `"name": "broods",\n      "version": "${declared}",`,
    `"name": "broods",\n      "version": "${next}",`,
  );
}

console.log(
  JSON.stringify({
    current: current,
    declared: declared,
    next: next,
    bump: bump,
    commits: subjects.length,
    since: since ?? null,
  }),
);

async function replace(path: string, from: string, to: string): Promise<void> {
  const text = await Bun.file(path).text();
  if (!text.includes(from))
    throw new Error(`Cannot find ${JSON.stringify(from)} in ${path}`);
  await Bun.write(path, text.replace(from, to));
}

function classify(commits: string[]): Bump {
  const breaks = (subject: string) =>
    BREAKING.test(subject) || subject.includes("BREAKING CHANGE");

  if (commits.length === 0) return "none";
  // Pre-1.0 has no stable surface to break, so `!` lands as a minor.
  if (commits.some(breaks)) return major === 0 ? "minor" : "major";
  if (commits.some((subject) => FEATURE.test(subject))) return "minor";

  return "patch";
}

function git(args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);

  return result.stdout.toString().trim();
}

// Newest commit that actually moved the version field. Dependency bumps touch
// package.json without releasing, so "last commit to the file" is not enough.
function lastBumpCommit(): string | undefined {
  const commits = git(["log", "--format=%H", "--", PACKAGE_PATH])
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    const before = versionAt(`${commit}^`);
    if (before !== undefined && before !== versionAt(commit)) return commit;
  }

  return undefined;
}

// The newest release the publish workflow tagged, or undefined before the first
// one. Sorted by version rather than by date so a re-cut old tag cannot win.
function lastReleaseTag(): { tag: string; version: string } | undefined {
  const tag = git(["tag", "--list", "broods-v*", "--sort=-v:refname"])
    .split("\n")
    .filter(Boolean)[0];
  if (!tag) return undefined;
  const version = tag.slice("broods-v".length);

  return SEMVER.test(version) ? { tag: tag, version: version } : undefined;
}

function nextVersion(bump: Exclude<Bump, "none">): string {
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;

  return `${major}.${minor}.${patch + 1}`;
}

function versionAt(ref: string): string | undefined {
  const result = Bun.spawnSync({
    cmd: ["git", "show", `${ref}:${PACKAGE_PATH}`],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;

  return JSON.parse(result.stdout.toString()).version as string;
}
