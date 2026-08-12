/**
 * A bundle's console.* must reach the host logger, not the worker's stderr:
 * the pooled worker discards stderr, so hook logs used to vanish entirely.
 * The shape mapper is the easy half; what actually broke was the frame surviving
 * the NDJSON parser and being emitted inside the run's observability context,
 * so these drive the real one-shot and pooled paths against a stub runner.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import {
  FrameQueue,
  parseToolRunnerFrame,
} from "../src/harness/bundles/payload.ts";
import { isolateLogRecord } from "../src/harness/isolate/executor.ts";
import {
  runWithObservabilityScope,
  setObservabilityContext,
  type ObservabilityContext,
} from "../src/shared/otel.ts";

const RUNNER_PATH = new URL(
  "../src/harness/isolate/runner/runner.mjs",
  import.meta.url,
).pathname;

function observability(accountId: string): ObservabilityContext {
  return {
    accountId: accountId,
    project: "checkout",
    stage: "prod",
    endpointId: "ep_1",
    agentId: "agent_1",
    conversationKey: "conv_1",
    traceId: "trace_1",
    otelContext: {} as ObservabilityContext["otelContext"],
    secretValues: [],
  };
}

// emit() writes every level to stdout as one JSON line, so stdout is where a
// host log line can be read back with the context it was emitted under.
async function captureEmitted(fn: () => Promise<void>): Promise<
  Array<Record<string, unknown>>
> {
  const lines: Array<Record<string, unknown>> = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Not one of ours.
        }
      }
    }

    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }

  return lines;
}

function payloadFor(toolName: string): Record<string, unknown> {
  const source = "export default {};";

  return {
    bundleSourceB64: Buffer.from(source).toString("base64"),
    expectedSha256: createHash("sha256").update(source).digest("hex"),
    toolName: toolName,
    input: {},
    config: {},
  };
}

describe("isolateLogRecord", () => {
  it("keeps the levels the host logger also has", () => {
    const levels = ["debug", "warn", "error"].map(
      (level) =>
        isolateLogRecord("acct_1", "my-agent-hooks", {
          t: "log",
          level: level,
          message: `${level} line`,
        }).level,
    );

    expect(levels).toEqual(["debug", "warn", "error"]);
  });

  it("treats console.log as info and tags the account and bundle", () => {
    expect(
      isolateLogRecord("acct_1", "my-agent-hooks", {
        t: "log",
        level: "log",
        message: "Received message from Zalo",
      }),
    ).toEqual({
      level: "info",
      message: "Received message from Zalo",
      data: {
        accountId: "acct_1",
        toolName: "my-agent-hooks",
        source: "user-code",
      },
    });
  });

  it("falls back to info for an unknown level", () => {
    expect(
      isolateLogRecord("acct_1", "hooks", {
        t: "log",
        level: "trace",
        message: "x",
      }).level,
    ).toBe("info");
  });

  it("still produces a record when the frame carries no message", () => {
    expect(isolateLogRecord(undefined, undefined, { t: "log" })).toEqual({
      level: "info",
      message: "",
      data: { accountId: undefined, source: "user-code" },
    });
  });
});

// The frame protocol is the seam the fix actually has to cross. A log frame the
// parser rejects is dropped before any handler sees it, which is silent: the
// tool still works, only the user's console.log is gone.
describe("log frames on the wire", () => {
  it("is a frame the NDJSON parser accepts", () => {
    expect(
      parseToolRunnerFrame(
        JSON.stringify({ t: "log", level: "log", message: "hi" }),
      ),
    ).toEqual({ t: "log", level: "log", message: "hi" });
  });

  it("still rejects a line that is not a protocol frame", () => {
    expect(parseToolRunnerFrame(JSON.stringify({ t: "nonsense" }))).toBeNull();
    expect(parseToolRunnerFrame("not json at all")).toBeNull();
  });

  it("reaches a FrameQueue consumer alongside the result", async () => {
    const queue = new FrameQueue();
    queue.push(
      `${JSON.stringify({ t: "log", level: "warn", message: "careful" })}\n`,
    );
    queue.push(`${JSON.stringify({ t: "final", result: 1 })}\n`);
    queue.close();

    const seen = [];
    for await (const frame of queue.frames()) seen.push(frame);

    expect(seen).toEqual([
      { t: "log", level: "warn", message: "careful" },
      { t: "final", result: 1 },
    ]);
  });

  // JSON escaping is what makes NDJSON safe here; a raw newline in the message
  // would split into two lines and neither would parse.
  it("survives a message containing newlines", () => {
    const line = JSON.stringify({
      t: "log",
      level: "log",
      message: "line one\nline two",
    });

    expect(line.includes("\n")).toBe(false);
    expect(parseToolRunnerFrame(line)).toEqual({
      t: "log",
      level: "log",
      message: "line one\nline two",
    });
  });
});

describe("user logs through the isolate paths", () => {
  const created: string[] = [];
  const savedRunnerPath = process.env.ISOLATE_RUNNER_PATH;
  const savedPool = process.env.ISOLATE_POOL;

  afterEach(async () => {
    if (savedRunnerPath === undefined) delete process.env.ISOLATE_RUNNER_PATH;
    else process.env.ISOLATE_RUNNER_PATH = savedRunnerPath;
    if (savedPool === undefined) delete process.env.ISOLATE_POOL;
    else process.env.ISOLATE_POOL = savedPool;
    setObservabilityContext(null);
    const { shutdownIsolatePool } = await import(
      "../src/harness/isolate/executor.ts"
    );
    shutdownIsolatePool();
    for (const dir of created.splice(0))
      await rm(dir, { recursive: true, force: true });
  });

  async function stubRunner(name: string, lines: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "broods-log-stub-"));
    created.push(dir);
    const path = join(dir, name);
    await writeFile(path, lines.join("\n"), "utf8");

    return path;
  }

  it("emits a one-shot runner's log frame under the run's tenant context", async () => {
    const stubPath = await stubRunner("one-shot.mjs", [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ t: 'log', level: 'log', message: 'hello from user code' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ t: 'final', result: { ok: true } }) + '\\n');",
      "});",
    ]);
    process.env.ISOLATE_POOL = "0";
    process.env.ISOLATE_RUNNER_PATH = stubPath;

    const { streamIsolatePayload } = await import(
      "../src/harness/isolate/executor.ts"
    );
    const outputs: unknown[] = [];
    const emitted = await captureEmitted(async () => {
      await runWithObservabilityScope(async () => {
        setObservabilityContext(observability("acct_oneshot"));
        for await (const output of streamIsolatePayload(
          "acct_oneshot",
          payloadFor("hooks"),
        )) {
          outputs.push(output);
        }
      });
    });

    expect(outputs).toEqual([{ ok: true }]);
    const line = emitted.find((e) => e.message === "hello from user code");
    expect(line).toBeDefined();
    // These three come from the observability context, so their presence is what
    // proves the line was emitted inside the run's scope and will route to the
    // right NATS subject rather than being dropped as unscoped.
    expect(line?.accountId).toBe("acct_oneshot");
    expect(line?.endpointId).toBe("ep_1");
    expect(line?.traceId).toBe("trace_1");
    expect(line?.source).toBe("user-code");
    expect(line?.level).toBe("INFO");
  });

  it("emits a pooled worker's log frame and drops one that names another call", async () => {
    const stubPath = await stubRunner("pool.mjs", [
      "process.stdout.write(JSON.stringify({ t: 'ready' }) + '\\n');",
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  let index;",
      "  while ((index = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, index);",
      "    buffer = buffer.slice(index + 1);",
      "    if (!line.trim()) continue;",
      "    const request = JSON.parse(line);",
      "    process.stdout.write(JSON.stringify({ t: 'log', callId: request.callId, level: 'log', message: 'pooled user line' }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ t: 'log', callId: 'someone-elses-call', level: 'error', message: 'LEAKED FROM ANOTHER RUN' }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ t: 'final', callId: request.callId, result: { ok: true } }) + '\\n');",
      "  }",
      "});",
    ]);
    delete process.env.ISOLATE_POOL;
    process.env.ISOLATE_RUNNER_PATH = stubPath;

    const { shutdownIsolatePool, streamIsolatePayload } = await import(
      "../src/harness/isolate/executor.ts"
    );
    shutdownIsolatePool();

    const outputs: unknown[] = [];
    const emitted = await captureEmitted(async () => {
      await runWithObservabilityScope(async () => {
        setObservabilityContext(observability("acct_pooled"));
        for await (const output of streamIsolatePayload(
          "acct_pooled",
          payloadFor("hooks"),
        )) {
          outputs.push(output);
        }
      });
    });

    expect(outputs).toEqual([{ ok: true }]);
    const line = emitted.find((e) => e.message === "pooled user line");
    expect(line).toBeDefined();
    expect(line?.accountId).toBe("acct_pooled");
    expect(line?.traceId).toBe("trace_1");
    // A frame stamped with a different call must never be emitted here: this
    // run's context would publish it to this tenant's subject.
    expect(
      emitted.some((e) => e.message === "LEAKED FROM ANOTHER RUN"),
    ).toBe(false);
  });

  // A runner that logs and then dies used to look like it had answered, because
  // any frame at all counted as a result. The tool then returned undefined with
  // nothing in the logs to say why.
  it("still reports a runner that logged and then died without a result", async () => {
    const stubPath = await stubRunner("dies.mjs", [
      "process.stdin.resume();",
      "process.stdout.write(JSON.stringify({ t: 'log', level: 'log', message: 'about to die' }) + '\\n');",
      "process.stderr.write('out of memory\\n');",
      "setTimeout(() => process.exit(9), 50);",
    ]);
    process.env.ISOLATE_POOL = "0";
    process.env.ISOLATE_RUNNER_PATH = stubPath;

    const { streamIsolatePayload } = await import(
      "../src/harness/isolate/executor.ts"
    );

    await captureEmitted(async () => {
      const drain = async (): Promise<void> => {
        for await (const _ of streamIsolatePayload(
          "acct_dies",
          payloadFor("hooks"),
        )) {
          /* no output expected */
        }
      };

      expect(drain()).rejects.toThrow(/did not return a result/);
      await drain().catch(() => {});
    });
  });
});

// The console surface is injected into the isolate as source text, so the only
// honest way to test it without isolated-vm is to run that exact text.
describe("the console injected into the isolate", () => {
  const emitted: Array<[string, string]> = [];
  const sandbox: Record<string, unknown> = {
    $0: {},
    $1: {},
    $2: () => undefined,
    $3: () => undefined,
    $4: (level: string, line: string) => {
      emitted.push([level, line]);
    },
    $5: {},
    $6: null,
    $7: null,
    $8: null,
  };
  const source = readFileSync(RUNNER_PATH, "utf8");
  const start = source.indexOf("await context.evalClosure(");
  const open = source.indexOf("`", start);
  let end = open + 1;
  for (; end < source.length; end += 1) {
    if (source[end] === "\\") {
      end += 1;
      continue;
    }
    if (source[end] === "`") break;
  }
  const closure = source.slice(open + 1, end);
  const context = createContext(sandbox);
  runInContext(
    // The runner file is JS source, so the escapes in it are for the outer
    // template literal; undo exactly those to get what the isolate compiles.
    closure.replace(/\\`/g, "`").replace(/\\\$\{/g, "${"),
    context,
  );
  const isolateConsole = (
    sandbox as { console: Record<string, (...args: unknown[]) => void> }
  ).console;

  function call(method: string, ...args: unknown[]): void {
    const fn = isolateConsole[method];
    if (!fn) throw new Error(`console.${method} is not defined in the isolate`);
    fn(...args);
  }

  function lastLine(): string {
    return emitted[emitted.length - 1]?.[1] ?? "";
  }

  it("renders an object structurally instead of [object Object]", () => {
    call("log", { orderId: 7, items: ["a"] });

    expect(lastLine()).toBe('{"orderId":7,"items":["a"]}');
  });

  it("does not throw on a circular reference", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    call("log", circular);

    expect(lastLine()).toContain("[Circular]");
  });

  it("does not throw on a null-prototype object", () => {
    expect(() => call("log", Object.create(null))).not.toThrow();
  });

  it("does not throw when toString itself throws", () => {
    const hostile = {
      toString: () => {
        throw new Error("no");
      },
    };

    expect(() => call("log", hostile)).not.toThrow();
  });

  it("joins mixed arguments the way console does", () => {
    call("log", "count:", 3, true, null);

    expect(lastLine()).toBe("count: 3 true null");
  });

  // A bundle reaching for console.trace or console.table must get a log line,
  // not "console.trace is not a function" halfway through a run.
  it("exposes every console method Node has", () => {
    for (const method of [
      "log",
      "info",
      "warn",
      "error",
      "debug",
      "trace",
      "dir",
      "table",
      "group",
      "groupCollapsed",
      "groupEnd",
      "time",
      "timeEnd",
      "timeLog",
      "count",
      "countReset",
      "assert",
    ]) {
      expect(typeof isolateConsole[method]).toBe("function");
      expect(() => call(method, "probe")).not.toThrow();
    }
  });

  it("caps a single enormous line rather than shipping it whole", () => {
    call("log", "x".repeat(200_000));

    expect(lastLine().length).toBeLessThan(9_000);
    expect(lastLine().endsWith("... [truncated]")).toBe(true);
  });

  // runner.mjs dispatches its entry point with a top-level await, so anything
  // declared below that dispatch is still in its temporal dead zone for the
  // whole run. A budget constant hoisted to module scope therefore throws
  // ReferenceError out of the console callback and into the tool the first time
  // a bundle logs — which reads to the account as their own tool crashing.
  it("keeps the log budget out of the module-scope dead zone", () => {
    const body = source.slice(source.indexOf("function makeLogEmitter("));

    expect(body).toContain("const budgetBytes");
    expect(body).toContain("const budgetLines");
    expect(/^const LOG_BUDGET/m.test(source)).toBe(false);
  });
});
