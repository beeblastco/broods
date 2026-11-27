import { appendFileSync, existsSync, readFileSync } from "node:fs";

const LOWEST_FILES = 15;

interface FileCoverage {
  file: string;
  found: number;
  hit: number;
}

// `bun scripts/coverage-summary.ts <title> <lcov.info>`: CI appends a line-coverage report
// to the job summary. Report only: it never fails the build.
if (import.meta.main) {
  const [title, lcovPath] = process.argv.slice(2);
  if (!title || !lcovPath) {
    throw new Error("usage: coverage-summary.ts <title> <lcov.info>");
  }
  const report = existsSync(lcovPath)
    ? coverageReport(title, readFileSync(lcovPath, "utf8"))
    : `### ${title} coverage\n\nno ${lcovPath}: the tests did not write coverage.\n`;
  console.log(report);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, report);
}

/** Markdown: total line coverage, then the least-covered source files. */
export function coverageReport(title: string, lcov: string): string {
  const files = parseLcov(lcov).filter(
    (entry) => entry.found > 0 && !entry.file.startsWith(".."),
  );
  const found = files.reduce((total, entry) => total + entry.found, 0);
  const hit = files.reduce((total, entry) => total + entry.hit, 0);
  const lowest = [...files]
    .sort(
      (left, right) => ratio(left) - ratio(right) || right.found - left.found,
    )
    .slice(0, LOWEST_FILES);

  return [
    `### ${title} coverage: ${percent(hit, found)} of ${found} lines in ${files.length} files`,
    "",
    "| least covered | lines | covered |",
    "| --- | --- | --- |",
    ...lowest.map(
      (entry) =>
        `| ${entry.file} | ${entry.found} | ${percent(entry.hit, entry.found)} |`,
    ),
    "",
  ].join("\n");
}

// One entry per `SF:` record, from its `LF:` (lines found) and `LH:` (lines hit) totals.
function parseLcov(lcov: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: FileCoverage | undefined;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { file: line.slice(3), found: 0, hit: 0 };
      files.push(current);
    } else if (current && line.startsWith("LF:")) {
      current.found = Number(line.slice(3));
    } else if (current && line.startsWith("LH:")) {
      current.hit = Number(line.slice(3));
    }
  }

  return files;
}

// `hit / found` as a percentage with one decimal.
function percent(hit: number, found: number): string {
  return found === 0 ? "n/a" : `${((100 * hit) / found).toFixed(1)}%`;
}

// Share of a file's lines the tests ran, 0 to 1.
function ratio(entry: FileCoverage): number {
  return entry.hit / entry.found;
}
