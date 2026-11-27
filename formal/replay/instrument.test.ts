import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../scripts/functions.ts";

const DIR = "formal/.lake/instrument-test";
const TRACES = join(ROOT, DIR, "traces");

interface Case {
  name: string;
  body: string;
}

// Each body runs as the same function before and after instrumentation, with the tracer live, and
// must return the same value, throw the same way, and log the same order of events.
const CASES: readonly Case[] = [
  { name: "plain call", body: `return f(1);` },
  {
    name: "reads the method before the arguments",
    body: `const o = { get m() { log.push("get"); return (x: number) => x; } }; return o.m((log.push("arg"), 1));`,
  },
  {
    name: "argument replaces the method",
    body: `const o: Record<string, (x: number) => number> = { m: (x) => x + 1 }; return o.m((o.m = (x) => x + 100, 1));`,
  },
  {
    name: "this is kept",
    body: `const o = { v: 7, m() { return this.v; } }; return o.m();`,
  },
  {
    name: "optional call skips arguments",
    body: `const fn: undefined | ((x: number) => number) = undefined as undefined | ((x: number) => number); return fn?.((log.push("arg"), 1));`,
  },
  {
    name: "optional object skips arguments",
    body: `const o = null as null | { m(x: number): number }; return o?.m((log.push("arg"), 1));`,
  },
  {
    name: "optional object with a missing method throws",
    body: `const o = {} as { m(x: number): number }; return o?.m((log.push("arg"), 1));`,
  },
  {
    name: "optional method on a present object",
    body: `const o = {} as { m?: (x: number) => number }; return o.m?.((log.push("arg"), 1));`,
  },
  {
    name: "computed key with a call inside",
    body: `const o: Record<string, () => number> = { a: () => 3 }; const key = () => { log.push("key"); return "a"; }; return o[key()]();`,
  },
  {
    name: "generics",
    body: `const id = <T,>(x: T): T => x; return id<number>(f(2));`,
  },
  {
    name: "chained calls",
    body: `const o = { a() { log.push("a"); return { b() { log.push("b"); return 5; } }; } }; return o.a().b();`,
  },
  { name: "ternary arms", body: `return f(1) > 0 ? f(2) : f(3);` },
  { name: "logical arms", body: `return f(0) || f(4);` },
  { name: "nullish arm", body: `return (null as number | null) ?? f(5);` },
  {
    name: "single statement branches",
    body: `if (f(1) > 0) log.push("y"); else log.push("n"); for (const x of [1, 2]) log.push(String(x)); return 1;`,
  },
  {
    name: "dangling else",
    body: `if (f(1) > 0) if (f(0) > 0) return 1; else return 2; return 3;`,
  },
  {
    name: "switch",
    body: `switch (f(2)) { case 1: return "a"; case 2: { log.push("two"); } case 3: return "b"; default: return "c"; }`,
  },
  {
    name: "expression arrows",
    body: `return [1, 2].map((x) => f(x)).filter((x) => x > 1);`,
  },
  {
    name: "arrow returning an object",
    body: `const g = (x: number) => ({ x: f(x) }); return g(4);`,
  },
  {
    name: "try and finally order",
    body: `try { log.push("t"); throw new TypeError("x"); } catch (e) { log.push((e as Error).name); return 9; } finally { log.push("f"); }`,
  },
  { name: "thrown from a callee", body: `boom();` },
  {
    name: "labelled loop",
    body: `outer: for (const a of [1, 2]) { for (const b of [1, 2]) { if (b === 2) continue outer; log.push(String(a + b)); } } return 0;`,
  },
  {
    name: "new Date with no arguments",
    body: `return typeof new Date().getTime();`,
  },
  {
    name: "await in arguments keeps method lookup first",
    body: `const o = { get m() { log.push("get"); return (x: number) => x; } }; return o.m(await Promise.resolve(1));`,
  },
  {
    name: "Promise.all order",
    body: `return await Promise.all([later(1), later(2)]);`,
  },
  {
    name: "rejected promise",
    body: `try { await rejects(); return 0; } catch (e) { return (e as Error).message; }`,
  },
  { name: "spread", body: `const args = [1] as [number]; return f(...args);` },
  {
    name: "getter is not run by recording",
    body: `let reads = 0; const o = { get v() { reads += 1; return 1; } }; take(o); return reads;`,
  },
  {
    name: "toJSON is not run by recording",
    body: `let reads = 0; take({ toJSON() { reads += 1; return 1; } }); return reads;`,
  },
  {
    name: "deep optional chain",
    body: `const o = { a: { b: () => 1 } } as { a?: { b(): number } }; return o.a?.b();`,
  },
  {
    name: "comment between callee and arguments",
    body: `return f /* ( */ (1);`,
  },
  {
    name: "two functions in one const",
    body: `const value = helperA() + helperB(); return value;`,
  },
  {
    name: "new with arguments",
    body: `const u = new Thing(f(2)); return u.value;`,
  },
  { name: "new with no parens", body: `const u = new Thing; return u.value;` },
  { name: "new of a thrower", body: `new Bad(); return 1;` },
  {
    name: "nested member chain",
    body: `const x = { y(n: number) { log.push("y" + n); return { z() { log.push("z"); return 8; } }; } }; return x.y(f(1)).z();`,
  },
  {
    name: "parameter default with a call",
    body: `const g = (x = f(3)) => x; return g();`,
  },
  {
    name: "escaped callback",
    body: `let seen = 0; await run2(async (x: number) => { seen = f(x); }); return seen;`,
  },
  {
    name: "escaped option callback with destructured arguments",
    body: `let seen = 0; run3({ onDone: ({ a }: { a: number }, b = 1) => { seen = a + b; } }); return seen;`,
  },
  { name: "environment read", body: `return typeof process.env.HOME;` },
  {
    name: "environment write",
    body: `process.env.SPEC_TMP = "x"; delete process.env.SPEC_TMP; return process.env.SPEC_TMP === undefined;`,
  },
  {
    name: "module state",
    body: `counter += 1; registry.set("k", counter); return registry.get("k");`,
  },
  {
    name: "class with private fields",
    body: `const b = new Box(); take(b); return b.read();`,
  },
  {
    name: "computed environment read",
    body: `const k = "HOME"; return typeof process.env[k];`,
  },
  {
    name: "callbacks on a local options object",
    body: `let seen = 0; const options = { nested: { onDone: (x: number) => { seen = f(x); } } }; run4(options); return seen;`,
  },
  {
    name: "abort flag read",
    body: `const c = new AbortController(); const before = c.signal.aborted; c.abort(); return [before, c.signal.aborted];`,
  },
  {
    name: "optional abort flag read",
    body: `const o = {} as { signal?: AbortSignal }; return o.signal?.aborted;`,
  },
  {
    name: "curried call",
    body: `const adder = (a: number) => (b: number) => a + b; return adder(f(1))(f(2));`,
  },
  {
    name: "callback behind a default",
    body: `const given = undefined as undefined | ((n: number) => number); let seen = 0; run5({ on: given ?? ((n: number) => { seen = n; return n; }) }); return seen;`,
  },
  {
    name: "writing a closed flag",
    body: `const s = { closed: false }; s.closed = true; return s.closed;`,
  },
  {
    name: "local helper called from a callback",
    body: `const finish = async (): Promise<number> => f(7); await run2(async (x: number) => { await finish(); f(x); }); return 1;`,
  },
  {
    name: "array from with a mapper",
    body: `return Array.from({ length: 2 }, () => f(3));`,
  },
  {
    name: "closure in an escaped object keeps its name and result",
    body: `const o = { call: (x: number) => f(x) }; take(o); return [o.call.name, o.call(4)];`,
  },
  { name: "void call", body: `void later(1); return f(2);` },
  {
    name: "awaited and unawaited callees",
    body: `const pending = stash(); registry.set("pending", 1); await pending; await stash(); return counter;`,
  },
  {
    name: "callee awaited inside an inner function",
    body: `const pending = (async (): Promise<void> => { await stash(); })(); registry.set("own", 1); await pending; return counter;`,
  },
  {
    name: "callback handed to a callee",
    body: `await withCallback(() => { registry.set("cb", 4); }); return counter;`,
  },
  {
    name: "write after an await inside an inner function",
    body: `const pending = (async (): Promise<void> => { registry.set("late", await later(1)); })(); await settleLater(); await pending; return counter;`,
  },
  {
    name: "write after a race",
    body: `registry.set("won", await Promise.race([later(1), settleLater()])); return counter;`,
  },
  {
    name: "write beside an awaited element",
    body: `let seen = 0; await Promise.all([settleLater(), registry.set("late", 1), (seen = 1)]); return counter + seen;`,
  },
  {
    name: "two awaited elements",
    body: `if (registry.size > counter) return 0; await Promise.all([stash(), settleLater()]); return counter;`,
  },
  {
    name: "awaited through a combinator and a return",
    body: `if (registry.size > counter) return 0; await Promise.all([(stash() as Promise<number>)]); return stash();`,
  },
  {
    name: "typed non-null",
    body: `const o = { m: () => 2 } as { m?: () => number }; return o.m!();`,
  },
];

const PREFIX = `
const log: string[] = [];
function f(x: number): number { log.push("f" + x); return x; }
function boom(): never { throw new RangeError("boom"); }
function take(_x: unknown): void {}
async function later(x: number): Promise<number> { log.push("start" + x); await null; log.push("end" + x); return x; }
async function rejects(): Promise<never> { throw new Error("no"); }
async function run2(cb: (x: number) => Promise<void>): Promise<void> { await cb(4); }
function run4(o: { nested: { onDone: (x: number) => void } }): void { o.nested.onDone(6); }
function run5(o: { on: (n: number) => number }): void { o.on(9); }
function run3(o: { onDone: (x: { a: number }) => void }): void { o.onDone({ a: 5 }); }
class Box { #secret = 4; read(): number { return this.#secret; } }
let counter = 0;
const registry = new Map<string, number>();
const helperA = (): number => 1, helperB = (): number => 2;
async function stash(): Promise<number> { await null; counter += 1; return counter; }
async function withCallback(cb: () => void): Promise<void> { cb(); await null; counter += 1; }
async function settleLater(): Promise<void> { for (let i = 0; i < 5; i += 1) await null; counter += 1; }
class Thing { value: number; constructor(x = 7) { this.value = x; } }
class Bad { constructor() { throw new SyntaxError("bad"); } }
`;

async function run(path: string): Promise<unknown> {
  const module = (await import(path)) as {
    target: () => Promise<unknown>;
    log: string[];
  };
  try {
    return { value: await module.target(), log: module.log };
  } catch (error) {
    return {
      threw: (error as Error).name,
      log: module.log,
    };
  }
}

function moduleText(body: string): string {
  return `${PREFIX}\nexport async function target(): Promise<unknown> {\n${body}\n}\nexport { log };\n`;
}

function tracedName(index: number): string {
  return `${DIR}/traced${index}.ts`;
}

const LATE_MODULE = `${DIR}/late.ts`;
// Its closure outlives `target`, so it runs under a trace of its own once `target` has returned.
const LATE_TEXT = `${PREFIX}
export function target(): { run: () => Promise<number>; handOff: () => Promise<number> } {
  return {
    run: async (): Promise<number> => { await settleLater(); return counter; },
    handOff: async (): Promise<number> => { await withCallback(() => { registry.set("cb", 1); }); return counter; },
  };
}
async function relay(cb: () => void): Promise<void> { await null; cb(); }
export function hand(box: { sent: boolean }, cb: () => void): Promise<void> { return relay(cb); }
`;

const CAP_MODULE = `${DIR}/cap.ts`;
// `run` is traced 100 times at most; a later call must not spill its private method's effects.
const CAP_TEXT = `${PREFIX}
class Worker {
  async #inner(x: number): Promise<number> { await null; return f(x); }
  async run(x: number): Promise<number> { return this.#inner(x); }
}
const worker = new Worker();
export async function fill(count: number): Promise<void> { for (let i = 0; i < count; i += 1) await worker.run(i); }
export async function viaCaller(x: number): Promise<number> { return worker.run(x); }
`;

describe("instrumentation keeps behaviour", () => {
  beforeAll(async () => {
    mkdirSync(TRACES, { recursive: true });
    const sources = join(ROOT, DIR, "sources.txt");
    writeFileSync(
      sources,
      CASES.flatMap((_item, index) => [
        `${tracedName(index)}#target`,
        `${tracedName(index)}#helperA`,
        `${tracedName(index)}#helperB`,
        `${tracedName(index)}#stash`,
        `${tracedName(index)}#withCallback`,
        `${tracedName(index)}#settleLater`,
      ])
        .concat(
          ["target", "settleLater", "withCallback", "hand"].map(
            (name) => `${LATE_MODULE}#${name}`,
          ),
        )
        .concat(
          ["Worker.run", "Worker.#inner", "viaCaller"].map(
            (name) => `${CAP_MODULE}#${name}`,
          ),
        )
        .join("\n"),
    );
    process.env["SPEC_CORPUS"] = join(ROOT, DIR, "corpus");
    process.env["SPEC_TRACES"] = TRACES;
    process.env["SPEC_RECORD_SOURCES"] = sources;
    CASES.forEach((item, index) => {
      const text = moduleText(item.body);
      writeFileSync(join(ROOT, DIR, `plain${index}.ts`), text);
      writeFileSync(join(ROOT, tracedName(index)), text);
    });
    writeFileSync(join(ROOT, LATE_MODULE), LATE_TEXT);
    writeFileSync(join(ROOT, CAP_MODULE), CAP_TEXT);
    await import("./record-preload.ts");
  });

  afterAll(() => {
    rmSync(join(ROOT, DIR), { recursive: true, force: true });
  });

  test.each(CASES.map((item, index) => [item.name, index] as const))(
    "%s",
    async (_name, index) => {
      expect(await run(join(ROOT, tracedName(index)))).toEqual(
        await run(join(ROOT, DIR, `plain${index}.ts`)),
      );
    },
  );

  test("a nested chain labels each call by its own callee", async () => {
    const index = CASES.findIndex(
      (item) => item.name === "nested member chain",
    );
    await run(join(ROOT, tracedName(index)));
    const file = join(
      TRACES,
      `${encodeURIComponent(`${tracedName(index)}#target`)}.jsonl`,
    );
    const call = JSON.parse(
      readFileSync(file, "utf8").split("\n")[0] ?? "",
    ) as {
      effects: { fn: string }[];
    };
    expect(call.effects.map((effect) => effect.fn)).toEqual([
      "f",
      "x.y",
      "x.y(f(1)).z",
    ]);
  });

  test("a callback's entry is recorded with what it was given", async () => {
    const index = CASES.findIndex((item) => item.name === "escaped callback");
    await run(join(ROOT, tracedName(index)));
    const file = join(
      TRACES,
      `${encodeURIComponent(`${tracedName(index)}#target`)}.jsonl`,
    );
    const call = JSON.parse(
      readFileSync(file, "utf8").split("\n")[0] ?? "",
    ) as {
      effects: { fn: string; outcome: { returned?: unknown } }[];
    };
    expect(call.effects.map((effect) => effect.fn)).toEqual([
      "run2",
      "$enter:arg0",
      "f",
    ]);
    expect(call.effects[1]?.outcome.returned).toEqual([4]);
  });

  test("a recording shows the effects, in order, with statements run", async () => {
    const index = CASES.findIndex((item) => item.name === "ternary arms");
    await run(join(ROOT, tracedName(index)));
    const file = join(
      TRACES,
      `${encodeURIComponent(`${tracedName(index)}#target`)}.jsonl`,
    );
    const call = JSON.parse(
      readFileSync(file, "utf8").split("\n")[0] ?? "",
    ) as {
      effects: { fn: string; args: unknown }[];
      hits: number[];
    };
    expect(call.effects.map((effect) => [effect.fn, effect.args])).toEqual([
      ["f", [1]],
      ["f", [2]],
    ]);
    expect(call.hits.length).toBeGreaterThan(0);
  });

  test("a closure running as its own trace keeps an awaited callee's window", async () => {
    const module = (await import(join(ROOT, LATE_MODULE))) as {
      target: () => { run: () => Promise<number> };
    };
    const made = module.target();
    expect(await made.run()).toBe(1);
    const file = join(
      TRACES,
      `${encodeURIComponent(`${LATE_MODULE}#target/run`)}.jsonl`,
    );
    const call = JSON.parse(
      readFileSync(file, "utf8").split("\n")[0] ?? "",
    ) as {
      effects: {
        fn: string;
        moduleBefore?: Record<string, unknown>;
        moduleAfter?: Record<string, unknown>;
      }[];
    };
    const window = call.effects.find((effect) => effect.fn === "settleLater");
    expect([
      window?.moduleBefore?.["counter"],
      window?.moduleAfter?.["counter"],
    ]).toEqual([0, 1]);
  });

  test("a callback a closure hands on ends that closure's windows", async () => {
    const module = (await import(join(ROOT, LATE_MODULE))) as {
      target: () => { handOff: () => Promise<number> };
    };
    await module.target().handOff();
    const file = join(
      TRACES,
      `${encodeURIComponent(`${LATE_MODULE}#target/handOff`)}.jsonl`,
    );
    const call = JSON.parse(
      readFileSync(file, "utf8").split("\n")[0] ?? "",
    ) as {
      effects: { fn: string; moduleAfter?: Record<string, unknown> }[];
    };
    const window = call.effects.find((effect) => effect.fn === "withCallback");
    expect(window?.moduleAfter?.["registry"]).toEqual({ $map: [] });
  });

  test("an effect handed the caller's callback may change any argument", async () => {
    const module = (await import(join(ROOT, LATE_MODULE))) as {
      hand: (box: { sent: boolean }, cb: () => void) => Promise<void>;
    };
    const box = { sent: false };
    await module.hand(box, (): void => {
      box.sent = true;
    });
    const file = join(
      TRACES,
      `${encodeURIComponent(`${LATE_MODULE}#hand`)}.jsonl`,
    );
    const call = JSON.parse(
      readFileSync(file, "utf8").split("\n")[0] ?? "",
    ) as {
      effects: {
        fn: string;
        argWindows?: { index: number; after: unknown }[];
      }[];
    };
    const relay = call.effects.find((effect) => effect.fn === "relay");
    expect(relay?.argWindows).toEqual([
      {
        index: 0,
        before: { sent: false },
        after: { sent: true },
      },
    ]);
  });

  test("a callee past its trace limit leaves nothing in its caller's trace", async () => {
    const module = (await import(join(ROOT, CAP_MODULE))) as {
      fill: (count: number) => Promise<void>;
      viaCaller: (x: number) => Promise<number>;
    };
    await module.fill(100);
    expect(await module.viaCaller(500)).toBe(500);
    const file = join(
      TRACES,
      `${encodeURIComponent(`${CAP_MODULE}#viaCaller`)}.jsonl`,
    );
    const call = JSON.parse(
      readFileSync(file, "utf8").split("\n")[0] ?? "",
    ) as { effects: { fn: string }[] };
    expect(call.effects.map((effect) => effect.fn)).toEqual(["worker.run"]);
  });

  // Each callee window as [counter before, counter after, registry after].
  test.each([
    [
      "awaited and unawaited callees",
      "stash",
      [
        [0, 0, { $map: [] }],
        [1, 2, { $map: [["pending", 1]] }],
      ],
    ],
    [
      "callee awaited inside an inner function",
      "stash",
      [[0, 0, { $map: [] }]],
    ],
    ["callback handed to a callee", "withCallback", [[0, 0, { $map: [] }]]],
    [
      "write after an await inside an inner function",
      "settleLater",
      [[0, 0, { $map: [] }]],
    ],
    ["write after a race", "settleLater", [[0, 0, { $map: [] }]]],
    ["write beside an awaited element", "settleLater", [[0, 0, { $map: [] }]]],
    ["two awaited elements", "stash", [[0, 1, { $map: [] }]]],
    [
      "awaited through a combinator and a return",
      "stash",
      [
        [0, 1, { $map: [] }],
        [1, 2, { $map: [] }],
      ],
    ],
  ] as const)(
    "a callee answers only while its caller's own code is idle: %s",
    async (name, fn, expected) => {
      const index = CASES.findIndex((item) => item.name === name);
      await run(join(ROOT, tracedName(index)));
      const file = join(
        TRACES,
        `${encodeURIComponent(`${tracedName(index)}#target`)}.jsonl`,
      );
      const call = JSON.parse(
        readFileSync(file, "utf8").split("\n")[0] ?? "",
      ) as {
        effects: {
          fn: string;
          moduleBefore?: Record<string, unknown>;
          moduleAfter?: Record<string, unknown>;
        }[];
      };
      const windows = call.effects
        .filter((effect) => effect.fn === fn)
        .map((effect) => [
          effect.moduleBefore?.["counter"],
          effect.moduleAfter?.["counter"],
          effect.moduleAfter?.["registry"],
        ]);
      expect(windows).toEqual(expected);
    },
  );
});
