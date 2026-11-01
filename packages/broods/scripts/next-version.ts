// Anchored on the newest `broods-v*` tag: nothing writes a bump back to `dev`, so the
// package.json version can be stale. A package.json version above the tag is a deliberate
// cut (`bump: "declared"`), how a major like 1.0.0 ships.

const PACKAGE_PATH = "packages/broods/package.json";
const LOCK_PATH = "bun.lock";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const BREAKING = /^[a-z]+(\([^)]*\))?!:/;
const FEATURE = /^feat(\([^)]*\))?:/;

type Bump = "declared" | "major" | "minor" | "patch" | "none";

const write = process.argv.includes("--write");
process.chdir(git(["rev-parse", "--show-toplevel"]));

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

const bump =
  released && Bun.semver.order(declared, released.version) === 1
    ? "declared"
    : classify(subjects);
const next = nextVersion(bump);

if (write && next !== declared) {
  // Textual edits: bun.lock is JSONC and JSON.stringify would churn package.json. Frozen
  // installs check the workspace version in bun.lock, so both move. Both hold `declared`.
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
  // Pre-1.0 has no stable API to break, so `!` lands as a minor.
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

// Dependency bumps touch package.json without releasing: find the commit that moved `version`.
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

// By version, not date, so a re-cut old tag cannot win; a hand-pushed prerelease is skipped.
function lastReleaseTag(): { tag: string; version: string } | undefined {
  const tag = git(["tag", "--list", "broods-v*", "--sort=-v:refname"])
    .split("\n")
    .find((candidate) => SEMVER.test(candidate.slice("broods-v".length)));

  return tag ? { tag: tag, version: tag.slice("broods-v".length) } : undefined;
}

function nextVersion(bump: Bump): string {
  if (bump === "declared") return declared;
  if (bump === "none") return current;
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
