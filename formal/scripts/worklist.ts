import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeFile, ROOT } from "./functions.ts";
import { manifestSources } from "./inputs.ts";

const FORMAL = join(ROOT, "formal");
const TRACES = join(FORMAL, ".lake/conform/traces");

interface Item {
  source: string;
  statements: number;
  reached: number;
  traces: number;
  calls: string[];
  depth: number;
}

// Lists the functions that still need a twin, leaves first, because a twin earns credit only once
// the functions it calls have theirs. Writes one TSV per subsystem to `.lake/worklist/`.
function main(): void {
  const credited = creditedSources();
  const subsystemOf = readSubsystems();
  const items = new Map<string, Item>();
  for (const file of manifestSources()) {
    if (!/\.(ts|mjs)$/.test(file) || file.endsWith(".d.ts")) continue;
    const analysis = analyzeFile(file, readFileSync(join(ROOT, file), "utf8"));
    for (const fn of analysis.functions) {
      if (!fn.wrappable || credited.has(fn.source)) continue;
      const sites = analysis.statements.filter((s) => s.owner === fn.source);
      if (sites.length === 0) continue;
      const path = join(TRACES, `${encodeURIComponent(fn.source)}.jsonl`);
      const hits = new Set<number>();
      const calls = new Set<string>();
      let traces = 0;
      if (existsSync(path)) {
        for (const line of readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)) {
          const call = JSON.parse(line) as {
            hits: number[];
            effects: { to?: string }[];
          };
          traces += 1;
          for (const offset of call.hits) hits.add(offset);
          for (const effect of call.effects)
            if (effect.to) calls.add(effect.to);
        }
      }
      items.set(fn.source, {
        source: fn.source,
        statements: sites.length,
        reached: sites.filter((s) => hits.has(s.node.start)).length,
        traces: traces,
        calls: [...calls],
        depth: 0,
      });
    }
  }
  for (const item of items.values())
    item.depth = depthOf(item, items, new Set());
  mkdirSync(join(FORMAL, ".lake/worklist"), { recursive: true });
  const groups = new Map<string, Item[]>();
  for (const item of items.values()) {
    const group = subsystemOf.get(item.source.split("#")[0] ?? "") ?? "other";
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  for (const [group, list] of groups) {
    list.sort((a, b) => a.depth - b.depth || b.reached - a.reached);
    writeFileSync(
      join(FORMAL, `.lake/worklist/${group}.tsv`),
      `source\tstatements\treached\ttraces\tdepth\tcalls\n${list
        .map(
          (item) =>
            `${item.source}\t${item.statements}\t${item.reached}\t${item.traces}\t${item.depth}\t${item.calls.join(" ")}`,
        )
        .join("\n")}\n`,
    );
    const reached = list.reduce((sum, item) => sum + item.reached, 0);
    console.log(
      `${group}: ${list.length} functions, ${reached} reachable statements`,
    );
  }
}

function depthOf(
  item: Item,
  items: Map<string, Item>,
  seen: Set<string>,
): number {
  if (seen.has(item.source)) return 0;
  seen.add(item.source);
  let depth = 0;
  for (const callee of item.calls) {
    const next = items.get(callee);
    if (next) depth = Math.max(depth, 1 + depthOf(next, items, seen));
  }
  seen.delete(item.source);

  return depth;
}

function creditedSources(): Set<string> {
  const path = join(FORMAL, "coverage.json");
  const parsed = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as { creditedTwins?: string[] })
    : {};

  return new Set(parsed.creditedTwins ?? []);
}

function readSubsystems(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of [
    "access",
    "agent",
    "channels",
    "config",
    "hosted",
    "runs",
    "sandbox",
    "workers",
  ]) {
    const rows = readFileSync(join(FORMAL, "manifest", `${file}.tsv`), "utf8")
      .trim()
      .split("\n");
    for (const row of rows.slice(1)) out.set(row.split("\t")[0] ?? "", file);
  }

  return out;
}

main();
