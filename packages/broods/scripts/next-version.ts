/**
 * Derives the next SDK version from the conventional-commit subjects landed
 * since the last version bump. `--write` applies it to package.json and the
 * root bun.lock (frozen installs check the workspace version, so both move
 * together). Prints one JSON line either way; `bump: "none"` means no commit
 * since the last bump touched the package.
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

const current = JSON.parse(await Bun.file(PACKAGE_PATH).text())
  .version as string;
const parsed = SEMVER.exec(current);
if (!parsed) throw new Error(`Cannot bump a non-semver version: ${current}`);

const major = Number(parsed[1]);
const minor = Number(parsed[2]);
const patch = Number(parsed[3]);
const since = lastBumpCommit();
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
  await replace(
    PACKAGE_PATH,
    `"version": "${current}"`,
    `"version": "${next}"`,
  );
  await replace(
    LOCK_PATH,
    `"name": "broods",\n      "version": "${current}",`,
    `"name": "broods",\n      "version": "${next}",`,
  );
}

console.log(
  JSON.stringify({
    current: current,
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
