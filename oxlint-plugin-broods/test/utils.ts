import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");
const pluginPath = join(repoRoot, "oxlint-plugin-broods", "index.ts");

interface OxlintReport {
  readonly diagnostics: ReadonlyArray<{
    readonly code: string;
    readonly message: string;
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

export const lintFixture = (
  rule: string,
  source: string,
  settings: FixtureSettings = {},
): Array<Finding> => {
  const dir = mkdtempSync(join(tmpdir(), "broods-oxlint-"));
  try {
    const configPath = join(dir, ".oxlintrc.json");
    const sourcePath = join(dir, settings.filename ?? "fixture.ts");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        jsPlugins: [pluginPath],
        rules: { [rule]: ["error", ...(settings.ruleOptions ?? [])] },
      }),
    );
    writeFileSync(sourcePath, dedent(source));
    const result = Bun.spawnSync(
      [oxlintBin, "--format=json", "-c", configPath, sourcePath],
      { cwd: dir },
    );
    const stdout = result.stdout.toString();
    if (!stdout.trimStart().startsWith("{")) {
      throw new Error(`oxlint failed: ${stdout}${result.stderr.toString()}`);
    }
    const report = JSON.parse(stdout) as OxlintReport;
    const [plugin, name] = rule.split("/");
    return report.diagnostics
      .filter((diagnostic) => diagnostic.code === `${plugin}(${name})`)
      .map((diagnostic) => ({
        line: diagnostic.labels[0]?.span.line ?? 0,
        message: diagnostic.message,
      }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const ruleTester = (
  rule: string,
  settings: FixtureSettings = {},
): RuleTester => ({
  valid: (name, source) => {
    test(name, () => {
      expect(lintFixture(rule, source, settings)).toEqual([]);
    });
  },
  invalid: (name, source, expected) => {
    test(name, () => {
      expect(lintFixture(rule, source, settings)).toEqual(
        expected.map(({ line, message }) => ({
          line: line,
          message: expect.stringContaining(message),
        })),
      );
    });
  },
});
