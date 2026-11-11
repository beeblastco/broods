// Renders the "Socket transfer impact" pull request comment from the byte counts
// apps/gateway/tests/socket-transfer.test.ts writes. Prints nothing without PR numbers.
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const MARKER = "<!-- socket-transfer -->";
const PATH_NAME = /^[A-Za-z0-9][A-Za-z0-9 ,.-]{0,59}$/;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
const MAX_PATHS = 20;

export type Measurement = { bytes: number; ceiling: number };
export type Measurements = Map<string, Measurement>;

// The file comes from a pull request's run, so anyone can write it: only a plain path name
// and two byte counts get through, and nothing else in it can reach the comment.
export function parseMeasurements(text: string): Measurements {
  const measurements: Measurements = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return measurements;
  }
  if (typeof parsed !== "object" || parsed === null) return measurements;
  for (const [path, value] of Object.entries(parsed)) {
    const entry: unknown = value;
    if (measurements.size === MAX_PATHS) break;
    if (!PATH_NAME.test(path)) continue;
    if (typeof entry !== "object" || entry === null) continue;
    if (!("bytes" in entry) || !("ceiling" in entry)) continue;
    if (!isByteCount(entry.bytes) || !isByteCount(entry.ceiling)) continue;
    measurements.set(path, { bytes: entry.bytes, ceiling: entry.ceiling });
  }

  return measurements;
}

export function renderComment(
  pr: Measurements,
  base: Measurements,
  baseSha: string,
): string {
  const rows = [...pr].map(([path, measurement]): string => {
    const before = base.get(path)?.bytes;

    return `| ${path} | ${before === undefined ? "n/a" : count(before)} | ${count(measurement.bytes)} | ${change(before, measurement.bytes)} |`;
  });
  const over = [...pr]
    .filter(
      ([, measurement]): boolean => measurement.bytes >= measurement.ceiling,
    )
    .map(
      ([path, measurement]): string =>
        `${path} (${count(measurement.bytes)} of ${count(measurement.ceiling)} bytes)`,
    );
  const baseLine =
    base.size === 0
      ? "No numbers were found for the base branch, so this shows the pull request alone."
      : `Base measured at \`${COMMIT_SHA.test(baseSha) ? baseSha.slice(0, 7) : "unknown"}\`.`;

  return [
    MARKER,
    "### Socket transfer impact",
    "",
    `Bytes the gateway sends down the socket for what an open dashboard asks of it. ${baseLine}`,
    "",
    "| Path | Base bytes | PR bytes | Change |",
    "| --- | ---: | ---: | ---: |",
    ...rows,
    "",
    over.length === 0
      ? "No path is over its ceiling."
      : `Over its ceiling: ${over.join("; ")}.`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      pr: { type: "string" },
      base: { type: "string" },
      "base-sha": { type: "string" },
    },
  });
  const pr = readMeasurements(values.pr);
  if (pr.size > 0) {
    process.stdout.write(
      renderComment(
        pr,
        readMeasurements(values.base),
        values["base-sha"] ?? "",
      ),
    );
  }
}

function change(before: number | undefined, after: number): string {
  if (before === after) return "0.0%";
  if (before === undefined || before === 0) return "n/a";
  const percent = ((after - before) / before) * 100;

  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

function count(bytes: number): string {
  return bytes.toLocaleString("en-US");
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readMeasurements(file: string | undefined): Measurements {
  return parseMeasurements(
    file !== undefined && existsSync(file) ? readFileSync(file, "utf8") : "",
  );
}
