import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./functions.ts";

const FORMAL = join(ROOT, "formal");
const TOOLING = [
  "replay/instrument.ts",
  "replay/record-preload.ts",
  "scripts/functions.ts",
  "scripts/conform.ts",
];

const LEAN_ROOTS = [
  "Replay.lean",
  "Spec.lean",
  "Audit.lean",
  "lakefile.toml",
  "lake-manifest.json",
  "lean-toolchain",
];

// Hash of everything a twin result depends on: the source it describes, the Lean that describes
// it, the recording tools, and the recording. A result under a different hash earns nothing.
export function inputsHash(): string {
  const hash = createHash("sha256");
  hash.update(sourcesHash());
  for (const path of walk(join(FORMAL, "Spec"))) feed(hash, path);
  for (const path of walk(join(FORMAL, "TwinMain"))) feed(hash, path);
  for (const name of LEAN_ROOTS) feed(hash, join(FORMAL, name));
  for (const path of contractFiles()) feed(hash, path);
  for (const name of ["corpus", "traces", "captured.json"]) {
    const entry = join(FORMAL, ".lake/conform", name);
    if (!existsSync(entry)) continue;
    if (statSync(entry).isDirectory())
      for (const path of walk(entry)) feed(hash, path);
    else feed(hash, entry);
  }
  const baseline = join(FORMAL, ".lake/conform-baseline");
  if (existsSync(baseline)) for (const path of walk(baseline)) feed(hash, path);

  return hash.digest("hex");
}

// The runtime source and the recording tools: what a recording was captured against.
export function sourcesHash(): string {
  const hash = createHash("sha256");
  for (const path of manifestSources()) feed(hash, join(ROOT, path));
  for (const path of TOOLING) feed(hash, join(FORMAL, path));

  return hash.digest("hex");
}

function contractFiles(): string[] {
  const files = ["boundaries.tsv", "exclusions.tsv"].map((name) =>
    join(FORMAL, name),
  );
  for (const name of ["boundaries.d", "exclusions.d"]) {
    const directory = join(FORMAL, name);
    if (existsSync(directory)) files.push(...walk(directory));
  }

  return files.filter((path) => existsSync(path));
}

export function manifestSources(): string[] {
  const paths: string[] = [];
  for (const file of readdirSync(join(FORMAL, "manifest"))) {
    if (!file.endsWith(".tsv")) continue;
    const rows = readFileSync(join(FORMAL, "manifest", file), "utf8")
      .trim()
      .split("\n");
    for (const row of rows.slice(1)) paths.push(row.split("\t")[0] ?? "");
  }

  return paths.filter((path) => existsSync(join(ROOT, path))).sort();
}

function feed(hash: ReturnType<typeof createHash>, path: string): void {
  hash.update(relative(ROOT, path));
  hash.update(readFileSync(path));
}

function walk(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const path = join(directory, entry);

      return statSync(path).isDirectory() ? walk(path) : [path];
    });
}
