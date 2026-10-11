/**
 * Fails CI on a high or critical advisory in bun.lock that nobody has reviewed.
 * Exits 0 when clean, 1 on an unreviewed or expired advisory, 2 when the audit
 * itself could not run (so a registry outage never reads as "clean").
 */

interface Advisory {
  url: string;
  title: string;
  severity: "low" | "moderate" | "high" | "critical";
  vulnerable_versions: string;
}

interface Exception {
  package: string;
  advisory: string;
  /** Last day the exception holds; review it again before then. */
  expires: string;
  reason: string;
}

/** Reviewed, time-limited exceptions. Each one needs a reachability note. */
const EXCEPTIONS: Exception[] = [
  {
    package: "braces",
    advisory: "GHSA-vfj7-8cjw-p6xm",
    expires: "2027-01-11",
    reason:
      "No patched release exists (3.0.3 is latest). Reached only through micromatch in build/dev tooling (docs, shadcn CLI) and Daytona's Image.fromDockerfile, which core never calls; no runtime path expands untrusted patterns.",
  },
];

const audit = Bun.spawnSync(["bun", "audit", "--json"], { stderr: "inherit" });
let report: Record<string, Advisory[]>;
try {
  report = JSON.parse(audit.stdout.toString());
} catch {
  console.error(`bun audit did not return JSON (exit ${audit.exitCode})`);
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
const failures: string[] = [];
for (const [name, advisories] of Object.entries(report)) {
  for (const advisory of advisories) {
    if (advisory.severity !== "high" && advisory.severity !== "critical") {
      continue;
    }
    const id = advisory.url.split("/").at(-1) ?? advisory.url;
    const exception = EXCEPTIONS.find(
      (entry) => entry.package === name && entry.advisory === id,
    );
    const line = `${advisory.severity} ${name} ${advisory.vulnerable_versions} ${id}: ${advisory.title}`;
    if (!exception) {
      failures.push(line);
    } else if (exception.expires < today) {
      failures.push(`${line} (exception expired ${exception.expires})`);
    } else {
      console.log(`allowed until ${exception.expires}: ${line}`);
    }
  }
}

if (failures.length > 0) {
  console.error(
    [
      "Unreviewed high/critical advisories in bun.lock:",
      ...failures.map((line) => `  ${line}`),
      "Upgrade (a direct bump, or a root `overrides` entry for a transitive copy), or add a reviewed, dated exception to scripts/audit-gate.ts.",
    ].join("\n"),
  );
  process.exit(1);
}
console.log("No unreviewed high/critical advisories.");
