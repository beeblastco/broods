// Renders the "Socket transfer impact" pull request comment from the byte counts
// apps/gateway/tests/socket-transfer.test.ts writes.
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return measurements;
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

// `complete` is false when the measuring run did not succeed: paths may be missing.
export function renderComment(
  pr: Measurements,
  base: Measurements,
  baseSha: string,
  complete: boolean,
): string {
  const rows = [...pr].map(([path, measurement]): string => {
    const before = base.get(path)?.bytes;

    return `| ${path} | ${before === undefined ? "n/a" : count(before)} | ${count(measurement.bytes)} | ${change(before, measurement.bytes)} |`;
  });
  const missing = [...base]
    .filter(([path]): boolean => !pr.has(path))
    .map(
      ([path, measurement]): string =>
        `| ${path} | ${count(measurement.bytes)} | not measured | n/a |`,
    );
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
    ...missing,
    "",
    ...(complete
      ? []
      : ["The measuring run failed, so paths may be missing or over.", ""]),
    over.length > 0
      ? `Over its ceiling: ${over.join("; ")}.`
      : complete
        ? "No path is over its ceiling."
        : "",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      pr: { type: "string" },
      base: { type: "string" },
      "base-sha": { type: "string" },
      conclusion: { type: "string" },
    },
  });
  process.stdout.write(
    renderComment(
      readMeasurements(values.pr),
      readMeasurements(values.base),
      values["base-sha"] ?? "",
      values.conclusion === "success",
    ),
  );
}

function change(before: number | undefined, after: number): string {
  if (before === after) return "0.0%";
  if (before === undefined || before === 0) return "n/a";
  const percent = (((after - before) / before) * 100).toFixed(1);
  if (percent === "-0.0") return "0.0%";

  return `${percent.startsWith("-") || percent === "0.0" ? "" : "+"}${percent}%`;
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
