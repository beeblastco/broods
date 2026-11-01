// Exit 1 on an unreviewed or expired high/critical advisory or a stale exception; exit 2 when
// bun audit produced no report, so a registry outage never reads as clean.

const SEVERITIES = ["low", "moderate", "high", "critical"] as const;

interface Advisory {
  url: string;
  title: string;
  severity: (typeof SEVERITIES)[number];
  vulnerable_versions: string;
}

export interface Exception {
  package: string;
  advisory: string;
  expires: string;
  reason: string;
}

/** Reviewed, time-limited exceptions. Each one needs a reachability note. */
export const EXCEPTIONS: Exception[] = [];

// bun audit exits 0 when clean and 1 on advisories; any other exit or report is a failed audit.
export function judgeAudit(
  exitCode: number | null,
  stdout: string,
  exceptions: Exception[],
  today: string,
): { code: 0 | 1 | 2; lines: string[] } {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    report = undefined;
  }
  // Typed as the report it should be; the check below proves it before use.
  const advisories: [string, Advisory[]][] | undefined =
    report !== null && typeof report === "object" && !Array.isArray(report)
      ? Object.entries(report)
      : undefined;
  const wellFormed = advisories?.every(
    ([, list]) =>
      Array.isArray(list) &&
      list.length > 0 &&
      list.every(
        (advisory) =>
          SEVERITIES.includes(advisory?.severity) &&
          typeof advisory?.url === "string",
      ),
  );
  if (
    !advisories ||
    !wellFormed ||
    exitCode !== (advisories.length > 0 ? 1 : 0)
  ) {
    return {
      code: 2,
      lines: [
        `bun audit did not return an advisory report (exit ${exitCode}): ${stdout.slice(0, 500)}`,
      ],
    };
  }

  const lines: string[] = [];
  const failures: string[] = [];
  const used = new Set<Exception>();
  for (const [name, list] of advisories) {
    for (const advisory of list) {
      if (advisory.severity !== "high" && advisory.severity !== "critical") {
        continue;
      }
      const id = advisory.url.split("/").at(-1) ?? advisory.url;
      const exception = exceptions.find(
        (entry) => entry.package === name && entry.advisory === id,
      );
      const line = `${advisory.severity} ${name} ${advisory.vulnerable_versions} ${id}: ${advisory.title}`;
      if (!exception) {
        failures.push(line);
      } else if (exception.expires < today) {
        failures.push(`${line} (exception expired ${exception.expires})`);
      } else {
        used.add(exception);
        lines.push(`allowed until ${exception.expires}: ${line}`);
      }
    }
  }
  for (const exception of exceptions) {
    if (!used.has(exception)) {
      failures.push(
        `stale exception ${exception.package} ${exception.advisory}: no longer reported, remove it`,
      );
    }
  }

  if (failures.length > 0) {
    return {
      code: 1,
      lines: [
        ...lines,
        "Unreviewed high/critical advisories in bun.lock:",
        ...failures.map((line) => `  ${line}`),
        "Upgrade (a direct bump, or a root `overrides` entry for a transitive copy), or add a reviewed, dated exception to scripts/audit-gate.ts.",
      ],
    };
  }
  return {
    code: 0,
    lines: [...lines, "No unreviewed high/critical advisories."],
  };
}

if (import.meta.main) {
  const audit = Bun.spawnSync(["bun", "audit", "--json"], {
    stderr: "inherit",
  });
  const verdict = judgeAudit(
    audit.exitCode,
    audit.stdout.toString(),
    EXCEPTIONS,
    new Date().toISOString().slice(0, 10),
  );
  (verdict.code === 0 ? console.log : console.error)(verdict.lines.join("\n"));
  process.exit(verdict.code);
}
