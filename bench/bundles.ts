/**
 * Payload budgets for the two things that ship to other machines: the
 * dashboard's client JavaScript and the published CLI. Both need a build first,
 * so this runs inside the CI job that already builds each one rather than in
 * the timing suite.
 *
 *   bun bench/bundles.ts --check dashboard|cli    grade against bundle-budgets.json
 *   bun bench/bundles.ts --record dashboard|cli   adopt the current size as the baseline
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGETS_PATH = join(ROOT, "bench/bundle-budgets.json");
const DASHBOARD_STATIC = join(ROOT, "apps/dashboard/.next/static");
const CLI_DIST = join(ROOT, "packages/broods/dist");

type Target = "cli" | "dashboard";

interface BundleMetric {
  bytes: number;
  /** Absolute product ceiling in bytes. Growth past it fails regardless of drift. */
  ceilingBytes: number;
  /** Growth over the recorded size that fails, as a percentage. */
  maxGrowthPct: number;
}

interface BundleBudgets {
  recordedAt: string;
  metrics: Record<string, BundleMetric>;
}

const target = process.argv[3] as Target | undefined;
const mode = process.argv[2];
if ((mode !== "--check" && mode !== "--record") || !target) {
  console.error("usage: bun bench/bundles.ts --check|--record dashboard|cli");
  process.exit(2);
}

const measured = target === "dashboard" ? measureDashboard() : measureCli();
const budgets: BundleBudgets = existsSync(BUDGETS_PATH)
  ? (JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as BundleBudgets)
  : { recordedAt: "", metrics: {} };

if (mode === "--record") {
  for (const [name, bytes] of Object.entries(measured)) {
    const prior = budgets.metrics[name];
    budgets.metrics[name] = {
      bytes: bytes,
      ceilingBytes: prior?.ceilingBytes ?? Math.round(bytes * 1.5),
      maxGrowthPct: prior?.maxGrowthPct ?? 10,
    };
  }
  budgets.recordedAt = new Date().toISOString();
  writeFileSync(BUDGETS_PATH, `${JSON.stringify(budgets, null, 2)}\n`);
  console.log(
    `Recorded ${Object.keys(measured).length} ${target} sizes to bench/bundle-budgets.json.`,
  );
  process.exit(0);
}

let failing = 0;
console.log(
  `\n${"metric".padEnd(34)}${"size".padStart(11)}${"recorded".padStart(11)}${"delta".padStart(9)}${"ceiling".padStart(11)}  status`,
);
for (const [name, bytes] of Object.entries(measured)) {
  const budget = budgets.metrics[name];
  if (!budget) {
    console.log(
      `${name.padEnd(34)}${formatBytes(bytes).padStart(11)}${"-".padStart(11)}${"-".padStart(9)}${"-".padStart(11)}  NEW`,
    );
    continue;
  }
  const deltaPct = ((bytes - budget.bytes) / budget.bytes) * 100;
  const overCeiling = bytes > budget.ceilingBytes;
  const grew = deltaPct > budget.maxGrowthPct;
  const status = overCeiling ? "CEILING" : grew ? "LARGER" : "ok";
  if (overCeiling || grew) failing += 1;
  console.log(
    name.padEnd(34) +
      formatBytes(bytes).padStart(11) +
      formatBytes(budget.bytes).padStart(11) +
      `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%`.padStart(9) +
      formatBytes(budget.ceilingBytes).padStart(11) +
      `  ${status}`,
  );
}
if (failing > 0) {
  console.error(
    `\n${failing} ${target} bundle metric${failing === 1 ? "" : "s"} over budget. If the growth is intended, re-record with --record and explain it in the PR.`,
  );
  process.exit(1);
}
console.log(`\n${target} bundles within budget.`);

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** The published package as a user receives it: the CLI entry and everything under dist. */
function measureCli(): Record<string, number> {
  if (!existsSync(CLI_DIST)) {
    console.error(
      "packages/broods/dist is missing; run `bun run --filter broods build` first.",
    );
    process.exit(2);
  }
  const files = walk(CLI_DIST).filter((path) => path.endsWith(".js"));

  return {
    "cli/dist-js-total": files.reduce(
      (total, path) => total + statSync(path).size,
      0,
    ),
    "cli/entry": statSync(join(CLI_DIST, "cli/index.js")).size,
  };
}

/** Everything a browser can be asked to download for the dashboard. */
function measureDashboard(): Record<string, number> {
  if (!existsSync(DASHBOARD_STATIC)) {
    console.error(
      "apps/dashboard/.next/static is missing; run the dashboard build first.",
    );
    process.exit(2);
  }
  const files = walk(DASHBOARD_STATIC).filter((path) => path.endsWith(".js"));
  const sizes = files.map((path) => statSync(path).size);

  return {
    "dashboard/client-js-total": sizes.reduce((total, size) => total + size, 0),
    "dashboard/largest-chunk": Math.max(0, ...sizes),
  };
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }

  return found;
}
