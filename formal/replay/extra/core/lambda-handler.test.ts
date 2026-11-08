import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

class FakeStream extends EventEmitter {
  setEncoding(): void {}
  pause(): void {}
  resume(): void {}
}

class FakeWritable extends EventEmitter {
  written: string[] = [];
  ended = false;
  onWrite: ((text: string) => void) | null = null;

  write(text: string): boolean {
    this.written.push(text);
    this.onWrite?.(text);

    return true;
  }

  end(): void {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  pid = 424242;
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeWritable();
  stdio: [null, null, null, FakeWritable] = [
    null,
    null,
    null,
    new FakeWritable(),
  ];
  kill(): boolean {
    return true;
  }
}

interface ResponseSink {
  chunks: string[];
  ended: boolean;
  write: (chunk: string | Uint8Array) => boolean;
  end: () => void;
  once: () => void;
}

type HandlerEvent = Record<string, unknown>;
type Script = (child: FakeChild) => void;

const children: FakeChild[] = [];
const spawnMock = mock((): FakeChild => {
  const child = new FakeChild();
  child.stdin.onWrite = (): void => {
    const script = scripts.shift();
    if (script) queueMicrotask((): void => script(child));
  };
  children.push(child);

  return child;
});
const scripts: Script[] = [];

await mock.module("node:child_process", () => ({ spawn: spawnMock }));

// Lazy so the node:child_process mock above is in place first.
const { handler } =
  (await import("../../../../apps/lambda/handler.mjs")) as unknown as {
    handler: (event: unknown, stream: ResponseSink) => Promise<void>;
  };

const killSpy = spyOn(process, "kill").mockImplementation((): true => true);
const savedEnv = { ...process.env };

function sink(): ResponseSink {
  const stream: ResponseSink = {
    chunks: [],
    ended: false,
    write: (chunk: string | Uint8Array): boolean => {
      stream.chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );

      return true;
    },
    end: (): void => {
      stream.ended = true;
    },
    once: (): void => {},
  };

  return stream;
}

function event(tenant: string, extra: HandlerEvent = {}): HandlerEvent {
  return {
    toolName: "tool",
    tenantId: tenant,
    expectedSha256: "a".repeat(64),
    bundleSourceB64: Buffer.from("bundle").toString("base64"),
    ...extra,
  };
}

function say(lines: string): Script {
  return (child: FakeChild): void => {
    child.stdout.emit("data", Buffer.from(lines));
  };
}

function die(
  stderr: string,
  code: number | null,
  signal: string | null = null,
): Script {
  return (child: FakeChild): void => {
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("exit", code, signal);
    child.stdout.emit("end");
  };
}

// The bundle's rejection stops the run first; the child dies only because it was killed.
function dieAfterRejection(): Script {
  return (child: FakeChild): void => {
    setTimeout((): void => die("", 1)(child), 5);
  };
}

async function invoke(input: unknown, script?: Script): Promise<string> {
  if (script) scripts.push(script);
  const stream = sink();
  await handler(input, stream);
  expect(stream.ended).toBe(true);

  return stream.chunks.join("");
}

beforeEach((): void => {
  delete process.env.LAMBDA_TASK_ROOT;
  delete process.env.MCP_CHILD_REUSE;
  delete process.env.MCP_CHILD_MAX_CALLS;
  delete process.env.MCP_CHILD_IDLE_SECONDS;
  delete process.env.TOOL_RUNNER_TIMEOUT_SECONDS;
  children.length = 0;
  scripts.length = 0;
});

afterEach((): void => {
  process.env = { ...savedEnv };
});

test.each([
  ["null", null],
  ["a string", "nope"],
  ["no tool name", { toolName: 3 }],
])("rejects %s", async (_name: string, input: unknown): Promise<void> => {
  expect(await invoke(input)).toContain("invalid mcp runner event");
});

test("reuses a warm child for the same tenant and bundle", async (): Promise<void> => {
  expect(await invoke(event("warm_a"), say('{"t":"end"}\n'))).toContain(
    '"end"',
  );
  const again = await invoke(
    event("warm_a"),
    say('{"t":"final","id":"1"}\n{"t":"end"}\n'),
  );

  expect(again).toContain('"final"');
  expect(children.length).toBe(1);
});

test.each([
  ["reuse off", { MCP_CHILD_REUSE: "0" }],
  ["call cap", { MCP_CHILD_MAX_CALLS: "1" }],
])(
  "spawns again with %s",
  async (_name: string, env: Record<string, string>): Promise<void> => {
    Object.assign(process.env, env);
    await invoke(event(`cold_${_name}`), say('{"t":"end"}\n'));
    await invoke(event(`cold_${_name}`), say('{"t":"end"}\n'));

    expect(children.length).toBe(2);
  },
);

test("no tenant means no reuse", async (): Promise<void> => {
  const input = {
    toolName: "tool",
    bundleSourceB64: Buffer.from("b").toString("base64"),
  };
  await invoke(input, say('{"t":"end"}\n'));
  await invoke(input, say('{"t":"end"}\n'));

  expect(children.length).toBe(2);
});

test("a batch error frame retires the child", async (): Promise<void> => {
  const text = await invoke(
    event("retire_a"),
    say('{"t":"error","error":"bad"}\n'),
  );
  await invoke(event("retire_a"), say('{"t":"end"}\n'));

  expect(text).toContain("bad");
  expect(children.length).toBe(2);
});

test("frames split across chunks still end the batch", async (): Promise<void> => {
  const split: Script = (child: FakeChild): void => {
    child.stdout.emit("data", Buffer.from('{"t":"fin'));
    child.stdout.emit("data", Buffer.from('al","id":"1"}\n{"t":"e'));
    child.stdout.emit("data", Buffer.from('nd"}\ntrailing'));
  };

  expect(await invoke(event("split_a"), split)).not.toContain("trailing");
});

test.each([
  ["stderr", die("kaboom\n", 1), "kaboom"],
  ["exit code", die("", 7), "exit 7"],
  ["signal", die("", null, "SIGSEGV"), "signal SIGSEGV"],
])(
  "child death reports %s",
  async (_name: string, script: Script, expected: string): Promise<void> => {
    expect(await invoke(event(`dead_${_name}`), script)).toContain(expected);
  },
);

test("death after output ends the stream without an error", async (): Promise<void> => {
  const script: Script = (child: FakeChild): void => {
    child.stdout.emit("data", Buffer.from('{"t":"chunk"}\n'));
    die("", 1)(child);
  };

  expect(await invoke(event("late_a"), script)).not.toContain('"error"');
});

test("a spawn error reports the failure", async (): Promise<void> => {
  const script: Script = (child: FakeChild): void => {
    child.emit("error", new Error("spawn EPERM"));
    child.stdout.emit("end");
  };

  expect(await invoke(event("eperm_a"), script)).toContain("spawn EPERM");
});

test("a missing bundle source fails the run", async (): Promise<void> => {
  const text = await invoke(
    { toolName: "tool", tenantId: "t", expectedSha256: "b".repeat(64) },
    dieAfterRejection(),
  );

  expect(text).toContain(
    "mcp runner event needs one of bundleSourceB64 or bundleUrl",
  );
  expect(killSpy).toHaveBeenCalled();
});

test("downloads a bundle by url, and reports a bad status", async (): Promise<void> => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async (): Promise<Response> => new Response("code"),
  ) as unknown as typeof fetch;
  await invoke(
    { toolName: "tool", bundleUrl: "https://b.test/x.mjs" },
    say('{"t":"end"}\n'),
  );
  expect(children[0]?.stdio[3].ended).toBe(true);

  globalThis.fetch = mock(
    async (): Promise<Response> => new Response("no", { status: 403 }),
  ) as unknown as typeof fetch;
  const text = await invoke(
    { toolName: "tool", bundleUrl: "https://b.test/y.mjs" },
    dieAfterRejection(),
  );
  globalThis.fetch = savedFetch;

  expect(text).toContain("mcp server bundle fetch failed with HTTP 403");
});
