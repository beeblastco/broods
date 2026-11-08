import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { plugin } from "bun";
import { ROOT } from "../scripts/functions.ts";
import { instrument } from "./instrument.ts";

const CORPUS = process.env.SPEC_CORPUS ?? "";
const TRACES = process.env.SPEC_TRACES ?? "";
const SOURCES = process.env.SPEC_RECORD_SOURCES ?? "";
const FAULT_FILE = process.env.SPEC_FAULT_FILE ?? "";
const FAULT_FIND = process.env.SPEC_FAULT_FIND ?? "";
const FAULT_REPLACE = process.env.SPEC_FAULT_REPLACE ?? "";
const MAX_CALLS_PER_FUNCTION = 200;
const MAX_TRACES_PER_FUNCTION = 100;
const MAX_CALL_BYTES = 32_768;
const MAX_VALUE_BYTES = 131_072;
const MAX_TRACE_BYTES = 524_288;
const AMBIENT_CONTEXT = "$observabilityContext";
const SOCKET_CLASSES = new Set(["ServerWebSocket", "WebSocket"]);
const SOCKET_FIELDS = ["data", "readyState", "url", "remoteAddress"];
const MAX_DEPTH = 32;
const MAX_ENCODED_NODES = 8_192;
const MAX_FIELD_NODES = 256;
const FIELD_DEPTH = 3;
const NOT_BEHAVIOUR =
  /^(console|log|logger|this\.log|this\.logger|logInfo|logWarn|logError|logDebug|getObservabilityContext|runWithObservabilityScope|observabilityAttributes|z)\b/;
const ENVIRONMENT_EFFECTS = new Set([
  "Date.now",
  "Math.random",
  "performance.now",
  "crypto.randomUUID",
  "crypto.getRandomValues",
  "globalThis.crypto.randomUUID",
]);
const PURE_FUNCTIONS = new Set<unknown>([
  String,
  Number,
  Boolean,
  BigInt,
  Symbol,
  Array,
  Object,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURI,
  encodeURIComponent,
  decodeURI,
  decodeURIComponent,
  btoa,
  atob,
  structuredClone,
]);
const PURE_NAMESPACES = new Set<unknown>([
  JSON,
  Math,
  Object,
  Array,
  Number,
  String,
  Symbol,
  Reflect,
  Promise,
  Date,
  URL,
  Intl,
  Buffer,
]);
const PURE_CONSTRUCTORS = new Set<unknown>([
  Array,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Date,
  RegExp,
  URL,
  URLSearchParams,
  Headers,
  Promise,
  ArrayBuffer,
  Uint8Array,
  TextEncoder,
  TextDecoder,
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  AbortController,
  Request,
  Response,
  Blob,
]);
const PURE_PROTOTYPES = new Set<unknown>([
  Array.prototype,
  Map.prototype,
  Set.prototype,
  Date.prototype,
  RegExp.prototype,
  URL.prototype,
  URLSearchParams.prototype,
  Headers.prototype,
  Promise.prototype,
  ArrayBuffer.prototype,
  Uint8Array.prototype,
  Buffer.prototype,
  TextEncoder.prototype,
  TextDecoder.prototype,
  Error.prototype,
]);

type Callee = (...args: unknown[]) => unknown;
type Nested = boolean | "detached";
type Outcome =
  | { returned: string }
  | { threw: string; sync: boolean }
  | { pending: true };

interface Effect {
  fn: string;
  to: string | undefined;
  args: string;
  outcome: Outcome;
  start: number;
  settle: number | undefined;
  nested: Nested;
  // Set around a call to another traced method on the same object, whose writes are its own.
  selfBefore: string | undefined;
  selfAfter: string | undefined;
}

interface Frame {
  source: string;
  effects: Effect[];
  hits: Set<number>;
  clock: number;
  claimed: boolean;
  closed: boolean;
  env: Map<string, string>;
  params: string;
  module: string;
  aborted: boolean[];
  self: unknown;
  readers: Record<string, () => unknown> | undefined;
}

// Hashes, not lines: holding every recorded line in memory runs a large test suite out of memory.
const seen = new Map<string, Set<number | bigint>>();
const traced = new Map<string, Set<number | bigint>>();
const counts = new Map<string, Record<string, number>>();
const sourceOf = new WeakMap<object, string>();
const frames = new AsyncLocalStorage<Frame>();
// oxlint-disable-next-line typescript/unbound-method -- kept before tests can patch it
const promiseThen = Promise.prototype.then;
const settledValues = new WeakMap<Promise<unknown>, unknown>();
const privateReaders = new WeakMap<object, (value: object) => object>();
let budget = 0;

// With SPEC_CORPUS and SPEC_RECORD_SOURCES set, this wraps each listed function at load time and
// appends its calls to the corpus. Nothing on disk changes. With SPEC_TRACES set it also records,
// per call, the statements run and every effect made, for checking against a traced twin.
if (CORPUS && SOURCES) {
  const wanted = new Set(
    readFileSync(SOURCES, "utf8").split("\n").filter(Boolean),
  );
  const files = new Set(
    [...wanted].map((source) => source.split("#")[0] ?? ""),
  );
  mkdirSync(CORPUS, { recursive: true });
  if (TRACES) mkdirSync(TRACES, { recursive: true });
  Object.assign(globalThis, {
    __specWrap: wrap,
    __specFrame: claimFrame,
    __specInherit: (): Frame | undefined => frames.getStore(),
    __specCall: traceCall,
    __specMethod: traceMethod,
    __specNow: traceNow,
    __specNew: traceNew,
    __specEnter: traceEnter,
    __specEnv: traceEnv,
    __specParams: traceParams,
    __specModule: traceModule,
    __specPrivate: registerPrivateReader,
    __specAborted: traceAborted,
    __specHit: hit,
  });
  process.on("exit", flushCounts);
  plugin({
    name: "spec-record",
    setup: function (build): void {
      const names = [...files].map((file) =>
        file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
      );
      // Synchronous on purpose: core `require`s some of these, and that refuses an async load.
      build.onLoad({ filter: new RegExp(`(${names.join("|")})$`) }, (args) => {
        const file = relative(ROOT, args.path);
        const loader = args.path.endsWith(".mjs") ? "js" : "ts";
        const original = readFileSync(args.path, "utf8");
        const source =
          file === FAULT_FILE
            ? original.replace(FAULT_FIND, FAULT_REPLACE)
            : original;

        return { contents: instrument(file, source, wanted), loader: loader };
      });
    },
  });
}

// A plain function, with the name, length, prototype and properties of the one it stands in for.
// `expect(fn).toThrow()` refuses a Proxy, so a Proxy would change what the tests do.
function wrap<T extends Callee>(source: string, original: T): T {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    return observe(source, original, this, args);
  };
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(original) as object);
  sourceOf.set(wrapped, source);

  return wrapped as T;
}

function observe(
  source: string,
  target: Callee,
  self: unknown,
  args: unknown[],
): unknown {
  count(source, "attempted");
  const before = isPassive(args) ? safeJson(args) : undefined;
  if (!before) count(source, "notJson");
  const frame = TRACES && hasTraceRoom(source) ? newFrame(source) : undefined;
  if (frame) frame.self = self;
  if (TRACES && !frame) count(source, "overTraceCap");
  const traceArgs = frame ? encodeText(args) : "";
  const traceSelf = frame ? encodeText(self) : "";
  const run = (): unknown => Reflect.apply(target, self, args);
  const finish = (outcome: Outcome, plain: PlainOutcome): void => {
    if (before) write(source, before, plain, frame);
    if (frame) writeTrace(frame, traceArgs, traceSelf, outcome);
  };
  let result: unknown;
  try {
    result = frame ? frames.run(frame, run) : run();
  } catch (error) {
    finish(
      { threw: encodeText(error), sync: true },
      { threw: messageOf(error) },
    );
    throw error;
  }
  // Only a real promise: `.then` on a lazy thenable would run the query it describes.
  if (result instanceof Promise) {
    void Reflect.apply(promiseThen, result, [
      (value: unknown): void => {
        settledValues.set(result as Promise<unknown>, value);
        finish({ returned: encodeText(value) }, plainReturn(value));
      },
      (error: unknown): void => {
        finish(
          { threw: encodeText(error), sync: false },
          { threw: messageOf(error) },
        );
      },
    ]);
  } else {
    finish({ returned: encodeText(result) }, plainReturn(result));
  }

  return result;
}

type PlainOutcome = { returned?: string; threw?: string };

function plainReturn(value: unknown): PlainOutcome {
  return { returned: (isPassive(value) && safeJson(value)) || undefined };
}

function newFrame(source: string): Frame {
  return {
    source: source,
    effects: [],
    hits: new Set(),
    clock: 0,
    claimed: false,
    closed: false,
    env: new Map(),
    params: "null",
    module: "null",
    aborted: [],
    self: undefined,
    readers: undefined,
  };
}

// Called first thing in an instrumented body: the frame belongs to that invocation, and closures
// written inside it keep hold of it, whoever ends up running them.
function claimFrame(source: string): Frame | undefined {
  const frame = frames.getStore();
  if (!frame || frame.source !== source || frame.claimed) return undefined;
  frame.claimed = true;

  return frame;
}

function hit(frame: Frame | undefined, offset: number): void {
  frame?.hits.add(offset);
}

function hasTraceRoom(source: string): boolean {
  return (traced.get(source)?.size ?? 0) < MAX_TRACES_PER_FUNCTION;
}

function traceCall(
  frame: Frame | undefined,
  label: string,
  callee: Callee,
  nested: Nested,
): Callee {
  if (label === "getObservabilityContext" && frame) {
    return (...args: unknown[]): unknown => {
      const context = callee(...args);
      if (!frame.env.has(AMBIENT_CONTEXT))
        frame.env.set(AMBIENT_CONTEXT, encodeText(context));

      return context;
    };
  }
  if (
    !frame ||
    typeof callee !== "function" ||
    PURE_FUNCTIONS.has(callee) ||
    NOT_BEHAVIOUR.test(label)
  )
    return callee;

  return (...args: unknown[]): unknown =>
    record(frame, label, sourceOf.get(callee), args, nested, () =>
      Reflect.apply(callee, undefined, args),
    );
}

// Reads the method now, before the arguments run, as JavaScript does. The result is what the
// rewritten call site invokes, or undefined when an optional link says to skip the call.
function traceMethod(
  frame: Frame | undefined,
  label: string,
  receiver: Record<PropertyKey, Callee> | null | undefined,
  key: PropertyKey,
  optionalObject: boolean,
  optionalCall: boolean,
  nested: Nested,
): Callee | undefined {
  if (optionalObject && receiver == null) return undefined;
  const target = (receiver as Record<PropertyKey, Callee>)[key];
  if (optionalCall && target == null) return undefined;
  const invoke = (args: unknown[]): unknown =>
    Reflect.apply(target as Callee, receiver as unknown, args);
  const pure = isPure(receiver) && !ENVIRONMENT_EFFECTS.has(label);
  if (!frame || pure || NOT_BEHAVIOUR.test(label)) {
    return (...args: unknown[]): unknown => invoke(args);
  }

  return (...args: unknown[]): unknown =>
    record(
      frame,
      label,
      typeof target === "function" ? sourceOf.get(target) : undefined,
      args,
      nested,
      () => invoke(args),
      receiver === frame.self,
    );
}

function traceNew(
  frame: Frame | undefined,
  label: string,
  callee: new (...args: unknown[]) => unknown,
  nested: Nested,
): Callee {
  if (!frame || PURE_CONSTRUCTORS.has(callee)) {
    return (...args: unknown[]): unknown => Reflect.construct(callee, args);
  }

  return (...args: unknown[]): unknown =>
    record(frame, label, undefined, args, nested, () =>
      Reflect.construct(callee, args),
    );
}

// A callback was entered. To its function this is an answer from outside: what it was given.
function traceEnter(
  frame: Frame | undefined,
  label: string,
  args: unknown[],
): void {
  if (!frame) return;
  if (frame.closed) count(frame.source, "lateEffects");
  const start = frame.clock;
  frame.clock += 2;
  frame.effects.push({
    fn: `$enter:${label}`,
    to: undefined,
    args: "[]",
    outcome: { returned: encodeText(args) },
    start: start,
    settle: start + 1,
    nested: true,
    selfBefore: undefined,
    selfAfter: undefined,
  });
}

// Each read of an `aborted` or `closed` flag in order: these change across an await.
function traceAborted(
  frame: Frame | undefined,
  signal: Record<string, unknown> | null | undefined,
  optional: boolean,
  name: string,
): unknown {
  if (optional && signal == null) return undefined;
  const value = (signal as Record<string, unknown>)[name];
  if (frame && typeof value === "boolean") frame.aborted.push(value);

  return value;
}

function registerPrivateReader(
  owner: object,
  read: (value: object) => object,
): void {
  privateReaders.set(owner, read);
}

function privateFields(value: object): object {
  let current = Object.getPrototypeOf(value) as object | null;
  while (current) {
    const owner = (current as { constructor?: object }).constructor;
    const read = owner ? privateReaders.get(owner) : undefined;
    if (read) return read(value);
    current = Object.getPrototypeOf(current) as object | null;
  }

  return {};
}

function traceEnv(
  frame: Frame | undefined,
  name: string,
  value: unknown,
): unknown {
  if (frame && !frame.env.has(name)) frame.env.set(name, encodeText(value));

  return value;
}

function traceParams(frame: Frame | undefined, values: unknown[]): void {
  if (frame) frame.params = encodeText(values);
}

function traceModule(
  frame: Frame | undefined,
  readers: Record<string, () => unknown>,
): void {
  if (!frame) return;
  frame.readers = readers;
  frame.module = readModule(readers);
}

function readModule(readers: Record<string, () => unknown>): string {
  const snapshot: Record<string, unknown> = {};
  for (const [name, read] of Object.entries(readers)) {
    try {
      snapshot[name] = read();
    } catch {
      snapshot[name] = undefined;
    }
  }

  return encodeText(snapshot);
}

function traceNow(frame: Frame | undefined, nested: Nested): number {
  const now = Date.now();
  if (frame) {
    const start = frame.clock;
    frame.clock += 2;
    frame.effects.push({
      fn: "new Date",
      to: undefined,
      args: "[]",
      outcome: { returned: String(now) },
      start: start,
      settle: start + 1,
      nested: nested,
      selfBefore: undefined,
      selfAfter: undefined,
    });
  }

  return now;
}

function isPure(receiver: unknown): boolean {
  if (typeof receiver !== "object" && typeof receiver !== "function")
    return true;
  if (PURE_NAMESPACES.has(receiver)) return true;

  return PURE_PROTOTYPES.has(Object.getPrototypeOf(receiver));
}

function record(
  frame: Frame,
  label: string,
  to: string | undefined,
  args: unknown[],
  nested: Nested,
  invoke: () => unknown,
  onSelf = false,
): unknown {
  if (frame.closed) count(frame.source, "lateEffects");
  const effect: Effect = {
    fn: label,
    to: to,
    args: encodeText(args),
    outcome: { pending: true },
    start: frame.clock,
    settle: undefined,
    nested: nested,
    selfBefore: onSelf && to ? encodeText(frame.self) : undefined,
    selfAfter: undefined,
  };
  frame.clock += 1;
  frame.effects.push(effect);
  let result: unknown;
  const settle = (outcome: Outcome): void => {
    effect.outcome = outcome;
    effect.settle = frame.clock;
    frame.clock += 1;
    if (effect.selfBefore) effect.selfAfter = encodeText(frame.self);
  };
  try {
    result = invoke();
  } catch (error) {
    settle({ threw: encodeText(error), sync: true });
    throw error;
  }
  if (result instanceof Promise) {
    void Reflect.apply(promiseThen, result, [
      (value: unknown): void => {
        settledValues.set(result as Promise<unknown>, value);
        settle({ returned: encodeText(value) });
      },
      (error: unknown): void => {
        settle({ threw: encodeText(error), sync: false });
      },
    ]);
  } else {
    settle({ returned: encodeText(result) });
  }

  return result;
}

function encodeText(value: unknown): string {
  budget = MAX_ENCODED_NODES;
  const text = JSON.stringify(encode(value, 0, []));

  return text.length > MAX_VALUE_BYTES ? '{"$big":true}' : text;
}

// Turns a value into exact, collision-free JSON without running any of its code: no getters, no
// `toJSON`. A value this cannot carry becomes `$big` or `$opaque`, and `conform.ts` then withholds
// credit for that call unless `boundaries.tsv` declares why the content does not matter. An
// object property holding undefined counts as absent, as JSON and `Object.keys`-free code see it.
function encode(value: unknown, depth: number, path: object[]): unknown {
  budget -= 1;
  if (budget < 0) return { $big: true };
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string")
    return value.length > MAX_VALUE_BYTES ? { $big: true } : value;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? value
      : { $number: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "symbol") return { $symbol: String(value.description) };
  if (typeof value === "function") return { $fn: value.name };
  const back = path.indexOf(value);
  // A reference to an enclosing value is exact data: how far up it points.
  if (back !== -1) return { $ref: path.length - back };
  if (depth > MAX_DEPTH) return { $opaque: "too-deep" };
  const next = [...path, value];
  const inner = (item: unknown): unknown => encode(item, depth + 1, next);
  if (Array.isArray(value)) {
    return value.length > MAX_ENCODED_NODES
      ? { $big: true }
      : encodeArray(value, inner);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === Object.prototype || prototype === null) {
    return encodeProperties(value, inner);
  }
  if (value instanceof Error) {
    return {
      $error: {
        name: dataAt(value, "name"),
        message: errorMessage(value),
        fields: encodeProperties(value, inner),
        $class: classNameOf(value),
      },
    };
  }
  if (value instanceof Date)
    return { $date: Date.prototype.getTime.call(value) };
  if (value instanceof Map) {
    return { $map: Array.from(Map.prototype.entries.call(value), inner) };
  }
  if (value instanceof Set) {
    return { $set: Array.from(Set.prototype.values.call(value), inner) };
  }
  if (value instanceof RegExp) return { $regexp: String(value) };
  if (value instanceof URL) return { $url: value.href };
  if (value instanceof URLSearchParams)
    return { $params: Array.from(value.entries()) };
  if (value instanceof Headers)
    return { $headers: Array.from(value.entries()) };
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_VALUE_BYTES) return { $big: true };

    return {
      $bytes: Buffer.from(value as Uint8Array).toString("base64"),
    };
  }
  if (value instanceof Request) {
    return {
      $request: {
        method: value.method,
        url: value.url,
        headers: Array.from(value.headers.entries()),
      },
    };
  }
  if (value instanceof Response) {
    return {
      $response: {
        status: value.status,
        headers: Array.from(value.headers.entries()),
      },
    };
  }
  if (value instanceof AbortSignal) return { $signal: value.aborted };

  if (value instanceof Promise && settledValues.has(value)) {
    return {
      $opaque: "Promise",
      $fields: { $resolved: inner(settledValues.get(value)) },
    };
  }

  return { $opaque: classNameOf(value), $fields: scalarFields(value) };
}

// An instance's own plain data, which a twin may read. It is not compared, since it changes as the
// object is used, and it is kept small so that it cannot crowd out the rest of the recording.
function scalarFields(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const saved = budget;
  budget = Math.min(saved, MAX_FIELD_NODES);
  for (const [key, descriptor] of Object.entries({
    ...Object.getOwnPropertyDescriptors(value),
    ...Object.getOwnPropertyDescriptors(privateFields(value)),
  })) {
    if (!descriptor.enumerable || !("value" in descriptor)) continue;
    const item: unknown = descriptor.value;
    if (typeof item === "function") continue;
    out[key] = encode(item, MAX_DEPTH - FIELD_DEPTH, [value]);
  }
  if (SOCKET_CLASSES.has(classNameOf(value))) {
    const socket = value as Record<string, unknown>;
    for (const name of SOCKET_FIELDS) {
      try {
        out[name] = encode(socket[name], MAX_DEPTH - FIELD_DEPTH, [value]);
      } catch {
        out[name] = { $opaque: "unreadable" };
      }
    }
  }
  budget = saved;

  return out;
}

function encodeArray(
  value: unknown[],
  inner: (item: unknown) => unknown,
): unknown[] {
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor) out.push(inner(undefined));
    else if ("value" in descriptor) out.push(inner(descriptor.value));
    else out.push({ $opaque: "accessor" });
  }

  return out;
}

// Reads a data property up the prototype chain without running a getter.
function dataAt(value: object, key: string): unknown {
  let current: object | null = value;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current) as object | null;
  }

  return undefined;
}

// Some error classes compute `message` in a getter. Callers read it, so it is part of the error.
function errorMessage(value: Error): unknown {
  try {
    return value.message;
  } catch {
    return undefined;
  }
}

function classNameOf(value: object): string {
  const owner = dataAt(value, "constructor");
  // A generator object's constructor slot holds a prototype, not a class.
  if (typeof owner !== "function")
    return Object.prototype.toString.call(value).slice(8, -1);
  const name = dataAt(owner, "name");

  return typeof name === "string" ? name : "object";
}

function encodeProperties(
  value: object,
  inner: (item: unknown) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (key === "stack" || !descriptor.enumerable) continue;
    const name = key.startsWith("$") ? `$${key}` : key;
    const encoded =
      "value" in descriptor
        ? descriptor.value === undefined
          ? undefined
          : inner(descriptor.value)
        : { $opaque: key === "jsonSchema" ? "jsonSchema" : `accessor:${key}` };
    if (encoded !== undefined) {
      // A plain assignment to `__proto__` would set the prototype and lose the data.
      Object.defineProperty(out, name, {
        value: encoded,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  const keys = Object.keys(out);
  // Lean's JSON sorts object keys, so a twin rendering JSON text needs the original order.
  if (keys.some((key, index) => index > 0 && (keys[index - 1] as string) > key))
    out["$keys"] = keys;

  return out;
}

// True when plain `JSON.stringify` would read only data: no accessors, no custom `toJSON`.
function isPassive(value: unknown, depth = 0, path: object[] = []): boolean {
  if (typeof value === "string") return value.length <= MAX_CALL_BYTES;
  if (value === null || typeof value !== "object") return true;
  if (depth > MAX_DEPTH || path.includes(value)) return false;
  const next = [...path, value];
  if (Array.isArray(value)) {
    if (value.length > MAX_ENCODED_NODES) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor && !("value" in descriptor)) return false;
      if (descriptor && !isPassive(descriptor.value, depth + 1, next))
        return false;
    }

    return true;
  }
  if (value instanceof Date) {
    return (
      Object.getPrototypeOf(value) === Date.prototype &&
      !Object.hasOwn(value, "toJSON")
    );
  }
  if (value instanceof Error) return true;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;

  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) =>
      "value" in descriptor &&
      typeof descriptor.value !== "function" &&
      isPassive(descriptor.value, depth + 1, next),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(
      value,
      (_key: string, item: unknown): unknown => {
        // An Error's message is not enumerable, so plain JSON would drop the part callers read.
        // oxlint-disable-next-line typescript/no-misused-spread -- copies an Error's own fields
        if (item instanceof Error) return { ...item, message: item.message };
        if (
          typeof item === "symbol" ||
          typeof item === "bigint" ||
          item instanceof Map ||
          item instanceof Set ||
          item instanceof Request ||
          item instanceof Response ||
          item instanceof AbortSignal ||
          item instanceof Uint8Array
        ) {
          throw new Error("not JSON");
        }

        return item;
      },
    );

    return text === undefined ? "null" : text;
  } catch {
    return undefined;
  }
}

function count(source: string, key: string): void {
  const row = counts.get(source) ?? {};
  counts.set(source, row);
  row[key] = (row[key] ?? 0) + 1;
}

function flushCounts(): void {
  if (!TRACES) return;
  const lines = [...counts.entries()].map(([fn, row]) =>
    JSON.stringify({ fn: fn, ...row }),
  );
  if (lines.length > 0)
    appendFileSync(join(TRACES, "_counts.txt"), `${lines.join("\n")}\n`);
}

function write(
  source: string,
  args: string,
  outcome: PlainOutcome,
  frame: Frame | undefined,
): void {
  if (outcome.threw === undefined && outcome.returned === undefined) {
    count(source, "resultNotJson");

    return;
  }
  const result =
    outcome.threw !== undefined
      ? JSON.stringify({ threw: outcome.threw })
      : `{"returned":${outcome.returned}}`;
  const hits = frame ? `,"hits":${JSON.stringify([...frame.hits])}` : "";
  const line = `{"fn":${JSON.stringify(source)},"args":${args},"outcome":${result}${hits}}`;
  if (line.length > MAX_CALL_BYTES) {
    count(source, "tooBig");

    return;
  }
  const calls = seen.get(source) ?? new Set<number | bigint>();
  seen.set(source, calls);
  const digest = Bun.hash(line);
  if (calls.has(digest)) return;
  if (calls.size >= MAX_CALLS_PER_FUNCTION) {
    count(source, "overCallCap");

    return;
  }
  calls.add(digest);
  appendFileSync(
    join(CORPUS, `${encodeURIComponent(source)}.jsonl`),
    `${line}\n`,
  );
}

function outcomeText(outcome: Outcome): string {
  if ("returned" in outcome) return `{"returned":${outcome.returned}}`;
  if ("threw" in outcome)
    return `{"threw":${outcome.threw},"sync":${String(outcome.sync)}}`;

  return '{"pending":true}';
}

function writeTrace(
  frame: Frame,
  args: string,
  self: string,
  outcome: Outcome,
): void {
  frame.closed = true;
  const effects = frame.effects
    .map((effect) => {
      const to = effect.to ? `,"to":${JSON.stringify(effect.to)}` : "";

      return `{"fn":${JSON.stringify(effect.fn)}${to},"args":${effect.args},"outcome":${outcomeText(effect.outcome)},"start":${effect.start},"settle":${effect.settle ?? "null"},"nested":${JSON.stringify(effect.nested)}${effect.selfBefore ? `,"selfBefore":${effect.selfBefore},"selfAfter":${effect.selfAfter ?? "null"}` : ""}}`;
    })
    .join(",");
  const env = [...frame.env.entries()]
    .map(([name, value]) => `${JSON.stringify(name)}:${value}`)
    .join(",");
  const line = `{"fn":${JSON.stringify(frame.source)},"args":${args},"self":${self},"params":${frame.params},"env":{${env}},"module":${frame.module},"aborted":${JSON.stringify(frame.aborted)},"selfAfter":${encodeText(frame.self)},"moduleAfter":${frame.readers ? readModule(frame.readers) : "null"},"effects":[${effects}],"outcome":${outcomeText(outcome)},"hits":${JSON.stringify([...frame.hits])}}`;
  if (line.length > MAX_TRACE_BYTES) {
    count(frame.source, "traceTooBig");

    return;
  }
  const lines = traced.get(frame.source) ?? new Set<number | bigint>();
  traced.set(frame.source, lines);
  const digest = Bun.hash(line);
  if (lines.has(digest)) return;
  lines.add(digest);
  appendFileSync(
    join(TRACES, `${encodeURIComponent(frame.source)}.jsonl`),
    `${line}\n`,
  );
}
