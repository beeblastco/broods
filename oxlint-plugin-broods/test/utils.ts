import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");
const pluginPath = join(repoRoot, "oxlint-plugin-broods", "index.ts");

interface OxlintReport {
  readonly diagnostics: ReadonlyArray<{
    readonly code: string;
    readonly message: string;
    readonly filename: string;
    readonly labels: ReadonlyArray<{
      readonly span: { readonly line: number };
    }>;
  }>;
}

export interface Finding {
  readonly line: number;
  readonly message: string;
}

export interface FixtureSettings {
  readonly filename?: string;
  readonly ruleOptions?: ReadonlyArray<unknown>;
}

export interface RuleTester {
  readonly valid: (name: string, source: string) => void;
  readonly invalid: (
    name: string,
    source: string,
    expected: ReadonlyArray<Finding>,
  ) => void;
}

const dedent = (source: string): string => {
  const lines = source
    .replace(/^\n/u, "")
    .replace(/\n\s*$/u, "")
    .split("\n");
  const indent = Math.min(
    ...lines
      .filter((line) => line.trim() !== "")
      .map((line) => line.length - line.trimStart().length),
  );
  return `${lines.map((line) => line.slice(indent)).join("\n")}\n`;
};

interface Fixture {
  readonly filename: string;
  readonly source: string;
  findings?: Array<Finding>;
}

interface FixtureGroup {
  readonly rule: string;
  readonly ruleOptions: ReadonlyArray<unknown>;
  readonly fixtures: Array<Fixture>;
}

const groups = new Map<string, FixtureGroup>();

// One oxlint spawn costs ~0.35s, so every fixture registered under a config so far shares one.
const lintPending = (group: FixtureGroup): void => {
  const pending = group.fixtures.filter((fixture) => !fixture.findings);
  const dir = mkdtempSync(join(tmpdir(), "broods-oxlint-"));
  try {
    const configPath = join(dir, ".oxlintrc.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        jsPlugins: [pluginPath],
        rules: { [group.rule]: ["error", ...group.ruleOptions] },
      }),
    );
    const paths = pending.map((fixture, index) => {
      const path = join(String(index), fixture.filename);
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), dedent(fixture.source));
      return path;
    });
    const result = Bun.spawnSync(
      [oxlintBin, "--format=json", "-c", configPath, ...paths],
      { cwd: dir },
    );
    const stdout = result.stdout.toString();
    if (!stdout.trimStart().startsWith("{")) {
      throw new Error(`oxlint failed: ${stdout}${result.stderr.toString()}`);
    }
    const report = JSON.parse(stdout) as OxlintReport;
    const [plugin, name] = group.rule.split("/");
    pending.forEach((fixture, index) => {
      fixture.findings = report.diagnostics
        .filter(
          (diagnostic) =>
            diagnostic.code === `${plugin}(${name})` &&
            diagnostic.filename === paths[index],
        )
        .map((diagnostic) => ({
          line: diagnostic.labels[0]?.span.line ?? 0,
          message: diagnostic.message,
        }));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const register = (
  rule: string,
  source: string,
  settings: FixtureSettings,
): (() => Array<Finding>) => {
  const ruleOptions = settings.ruleOptions ?? [];
  const key = JSON.stringify([rule, ruleOptions]);
  const group = groups.get(key) ?? {
    rule: rule,
    ruleOptions: ruleOptions,
    fixtures: [],
  };
  groups.set(key, group);
  const fixture: Fixture = {
    filename: settings.filename ?? "fixture.ts",
    source: source,
  };
  group.fixtures.push(fixture);
  return () => {
    if (!fixture.findings) lintPending(group);
    return fixture.findings ?? [];
  };
};

export const ruleTester = (
  rule: string,
  settings: FixtureSettings = {},
): RuleTester => ({
  valid: (name, source) => {
    const findings = register(rule, source, settings);
    test(name, () => {
      expect(findings()).toEqual([]);
    });
  },
  invalid: (name, source, expected) => {
    const findings = register(rule, source, settings);
    test(name, () => {
      expect(findings()).toEqual(
        expected.map(({ line, message }) => ({
          line: line,
          message: expect.stringContaining(message),
        })),
      );
    });
  },
});
