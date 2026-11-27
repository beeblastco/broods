import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync, type Program } from "oxc-parser";

const ROOT = join(import.meta.dir, "..");

const MIRRORS = join(import.meta.dir, "mirrors.json");

// Source positions and literal spelling; dropping them leaves what the code does.
const POSITION_KEYS = new Set(["start", "end", "range", "raw"]);

// Lean model -> TypeScript file -> symbol -> hash of its syntax tree.
type Mirrors = Record<string, Record<string, Record<string, string>>>;

interface Span {
  start: number;
  end: number;
}

// `bun verification/drift.ts` fails when code a Lean model mirrors changed since the model was
// last confirmed against it; `--write` re-pins every hash once the models describe the code.
if (import.meta.main) {
  const write = process.argv.includes("--write");
  const mirrors: Mirrors = JSON.parse(readFileSync(MIRRORS, "utf8"));
  const drifted: string[] = [];
  for (const [model, files] of Object.entries(mirrors)) {
    for (const [file, symbols] of Object.entries(files)) {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const [symbol, pinned] of Object.entries(symbols)) {
        const hash = symbolHash(file, source, symbol);
        if (hash === pinned) continue;
        symbols[symbol] = hash;
        drifted.push(`${model}: ${file} ${symbol}`);
      }
    }
  }
  if (write) {
    writeFileSync(MIRRORS, `${JSON.stringify(mirrors, null, 2)}\n`);
    console.log(`re-pinned ${drifted.length} symbol(s)`);
  } else if (drifted.length > 0) {
    console.error(
      [
        "Code a Lean model mirrors changed since the model was last confirmed:",
        ...drifted.map((line) => `  ${line}`),
        "Read verification/Broods/<model>.lean against it, update the model if the code changed",
        "shape, rerun `lake build`, then `bun verification/drift.ts --write`.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

/** Hash of `symbol` (`name` or `Class.method`): its syntax tree, without comments or layout. */
export function symbolHash(
  file: string,
  source: string,
  symbol: string,
): string {
  const { program, errors } = parseSync(file, source, {
    preserveParens: false,
  });
  const [error] = errors;
  if (error !== undefined) throw new Error(`${file}: ${error.message}`);
  const spans = symbolSpans(program, symbol);
  const [span] = spans;
  if (span === undefined || spans.length > 1) {
    throw new Error(
      `${file}: ${spans.length} definitions of ${symbol}, want exactly 1`,
    );
  }
  const tree = JSON.stringify(span, (key: string, value: unknown): unknown =>
    POSITION_KEYS.has(key) ? undefined : value,
  );

  return new Bun.CryptoHasher("sha256").update(tree).digest("hex").slice(0, 16);
}

// Top-level declarations and class methods only: a nested helper never shadows a mirrored name.
function symbolSpans(program: Program, symbol: string): Span[] {
  const [name, method] = symbol.split(".");

  return program.body.flatMap((statement): Span[] => {
    const node =
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (node === null) return [];
    if (method !== undefined) {
      if (node.type !== "ClassDeclaration" || node.id?.name !== name) return [];
      return node.body.body.filter(
        (element) =>
          element.type === "MethodDefinition" &&
          element.key.type === "Identifier" &&
          element.key.name === method,
      );
    }
    if (node.type === "VariableDeclaration") {
      return node.declarations.filter(
        (declarator) =>
          declarator.id.type === "Identifier" && declarator.id.name === name,
      );
    }
    const named =
      "id" in node && node.id?.type === "Identifier" && node.id.name === name;

    return named ? [node] : [];
  });
}
