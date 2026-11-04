import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

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
  readonly name: string;
  readonly filename: string;
  readonly ruleOptions: ReadonlyArray<unknown>;
  readonly source: string;
}

const fixturesByRule = new Map<string, Array<Fixture>>();
const outcomes = new Map<Fixture, Array<Finding> | Error>();

// An oxlint spawn is the slow part, so every fixture of a rule registered so far shares one;
// each sits in its own folder, which an override gives that fixture's options.
const lintPending = (rule: string, fixtures: Array<Fixture>): void => {
  const pending = fixtures.filter((fixture) => !outcomes.has(fixture));
  const dir = mkdtempSync(join(tmpdir(), "broods-oxlint-"));
  try {
    const configPath = join(dir, ".oxlintrc.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        jsPlugins: [pluginPath],
        overrides: pending.map((fixture, index) => ({
          files: [`${index}/**`],
          rules: { [rule]: ["error", ...fixture.ruleOptions] },
        })),
      }),
    );
    const paths = pending.map((fixture, index) => {
      const path = posix.join(String(index), fixture.filename);
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
      const cases = pending.map(
        (fixture, index) => `${paths[index]}: ${fixture.name}`,
      );
      const failure = new Error(
        `oxlint failed on one of:\n${cases.join("\n")}\n${stdout}${result.stderr.toString()}`,
      );
      for (const fixture of pending) outcomes.set(fixture, failure);
      return;
    }
    const report = JSON.parse(stdout) as OxlintReport;
    const [plugin, name] = rule.split("/");
    pending.forEach((fixture, index) => {
      outcomes.set(
        fixture,
        report.diagnostics
          .filter(
            (diagnostic) =>
              diagnostic.code === `${plugin}(${name})` &&
              // oxlint prints a file:// URL instead of the relative path in JetBrains terminals.
              `/${diagnostic.filename}`.endsWith(`/${paths[index]}`),
          )
          .map((diagnostic) => ({
            line: diagnostic.labels[0]?.span.line ?? 0,
            message: diagnostic.message,
          })),
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const register = (
  name: string,
  rule: string,
  source: string,
  settings: FixtureSettings,
): (() => Array<Finding>) => {
  const fixtures = fixturesByRule.get(rule) ?? [];
  fixturesByRule.set(rule, fixtures);
  const fixture: Fixture = {
    name: name,
    filename: settings.filename ?? "fixture.ts",
    ruleOptions: settings.ruleOptions ?? [],
    source: source,
  };
  fixtures.push(fixture);
  return () => {
    if (!outcomes.has(fixture)) lintPending(rule, fixtures);
    const outcome = outcomes.get(fixture);
    if (outcome instanceof Error) throw outcome;
    return outcome ?? [];
  };
};

export const ruleTester = (
  rule: string,
  settings: FixtureSettings = {},
): RuleTester => ({
  valid: (name, source) => {
    const findings = register(name, rule, source, settings);
    test(name, () => {
      expect(findings()).toEqual([]);
    });
  },
  invalid: (name, source, expected) => {
    const findings = register(name, rule, source, settings);
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
