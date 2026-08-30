/**
 * Warm child reuse in the hosted-MCP runner (#189), driven under real Node.
 * The handler keeps one child per accountId + sha256 and hands it repeat
 * calls; these tests pin the boxes that reuse must tick: the bundle is
 * fetched and parsed once, TMPDIR/HOME are fresh per call, a different tenant
 * or bundle never sees a used child, a failed run retires it, and the call
 * bound is enforced.
 */

import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const handlerPath = fileURLToPath(
  new URL("../../lambda/handler.mjs", import.meta.url),
);

interface HostedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface RunnerEvent {
  accountId?: string;
  bundle: string;
  reuse?: boolean;
  /** Pause after this invocation, for state that settles between calls. */
  waitMs?: number;
}

// A module-level counter is exactly the state process reuse preserves: a
// fresh child answers 1, a reused one counts up.
const COUNTER_BUNDLE = [
  `let calls = 0;`,
  `export default () => {`,
  `  calls += 1;`,
  `  return new Response(JSON.stringify({ calls: calls, home: process.env.TMPDIR }));`,
  `};`,
].join("\n");

// One driver process invokes the handler once per event, the way a warm
// Lambda environment serializes invocations, and reports each invocation's
// NDJSON alongside how many times the bundle was actually fetched.
async function invokeSequence(
  events: RunnerEvent[],
  parentEnv: Record<string, string> = {},
): Promise<{ runs: string[]; bundleFetches: number }> {
  const dir = await mkdtemp(join(tmpdir(), "broods-reuse-drv-"));
  let bundleFetches = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      bundleFetches += 1;
      const name = new URL(request.url).pathname.slice(1);
      const event = events.find((entry) => bundleName(entry.bundle) === name);

      return new Response(event?.bundle ?? "", {
        status: event ? 200 : 404,
      });
    },
  });
  try {
    const driver = join(dir, "driver.mjs");
    const driverEvents = events.map((event) => ({
      mode: "mcp",
      toolName: "server-under-test",
      ...(event.accountId !== undefined ? { accountId: event.accountId } : {}),
      ...(event.reuse !== undefined ? { reuse: event.reuse } : {}),
      ...(event.waitMs !== undefined ? { waitMs: event.waitMs } : {}),
      expectedSha256: new Bun.CryptoHasher("sha256")
        .update(event.bundle)
        .digest("hex"),
      bundleUrl: new URL(bundleName(event.bundle), server.url).href,
      mcpRequest: { method: "POST", headers: {}, body: "{}" },
    }));
    await writeFile(
      driver,
      [
        `import { PassThrough } from "node:stream";`,
        `import { handler } from ${JSON.stringify(handlerPath)};`,
        `const events = ${JSON.stringify(driverEvents)};`,
        `const runs = [];`,
        `for (const { waitMs, ...event } of events) {`,
        `  const responseStream = new PassThrough();`,
        `  let stdout = "";`,
        `  const consumed = (async () => {`,
        `    for await (const chunk of responseStream) stdout += chunk;`,
        `  })();`,
        `  await handler(event, responseStream);`,
        `  await consumed;`,
        `  runs.push(stdout);`,
        `  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));`,
        `}`,
        `process.stdout.write(JSON.stringify({ runs }));`,
        `process.exit(0);`,
      ].join("\n"),
    );

    const result = await new Promise<{ runs: string[] }>((resolve, reject) => {
      const child = spawn("node", [driver], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...parentEnv },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.once("error", reject);
      child.once("exit", () => {
        try {
          resolve(JSON.parse(out) as { runs: string[] });
        } catch {
          reject(new Error(`driver produced no JSON: ${out}${err}`));
        }
      });
    });

    return { runs: result.runs, bundleFetches: bundleFetches };
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}

function bundleName(bundle: string): string {
  return `${new Bun.CryptoHasher("sha256").update(bundle).digest("hex")}.mjs`;
}

function finalBody(run: string | undefined): unknown {
  const frame = terminalFrame(run);
  expect(frame?.t).toBe("final");

  return JSON.parse((frame!.result as HostedResponse).body);
}

function terminalFrame(
  run: string | undefined,
): { t: string; result?: unknown; error?: string } | undefined {
  return (run ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { t: string; result?: unknown; error?: string },
    )
    .at(-1);
}

describe("mcp-runner warm reuse", () => {
  it("reuses the child for the same account and bundle, fetching once", async () => {
    const { runs, bundleFetches } = await invokeSequence([
      { accountId: "acct-1", bundle: COUNTER_BUNDLE },
      { accountId: "acct-1", bundle: COUNTER_BUNDLE },
      { accountId: "acct-1", bundle: COUNTER_BUNDLE },
    ]);

    expect(
      runs.map((run) => (finalBody(run) as { calls: number }).calls),
    ).toEqual([1, 2, 3]);
    expect(bundleFetches).toBe(1);
  }, 30_000);

  it("gives every call a fresh TMPDIR and HOME", async () => {
    // Call N writes a file into its TMPDIR; call N+1 must neither share the
    // directory nor see the file. "Reset" has to mean reset.
    const bundle = [
      `import { writeFileSync, existsSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `let previous = null;`,
      `export default () => {`,
      `  const marker = join(process.env.TMPDIR, "leak.txt");`,
      `  const body = {`,
      `    home: process.env.TMPDIR,`,
      `    sameDirAsLastCall: previous === process.env.TMPDIR,`,
      `    previousMarkerVisible: previous !== null && existsSync(join(previous, "leak.txt")),`,
      `  };`,
      `  writeFileSync(marker, "leak");`,
      `  previous = process.env.TMPDIR;`,
      `  return new Response(JSON.stringify(body));`,
      `};`,
    ].join("\n");

    const { runs } = await invokeSequence([
      { accountId: "acct-1", bundle: bundle },
      { accountId: "acct-1", bundle: bundle },
    ]);
    const second = finalBody(runs[1]) as {
      sameDirAsLastCall: boolean;
      previousMarkerVisible: boolean;
    };

    expect(second.sameDirAsLastCall).toBe(false);
    expect(second.previousMarkerVisible).toBe(false);
  }, 30_000);

  it("never hands a used child to another account", async () => {
    const { runs } = await invokeSequence([
      { accountId: "acct-1", bundle: COUNTER_BUNDLE },
      { accountId: "acct-2", bundle: COUNTER_BUNDLE },
    ]);

    expect(
      runs.map((run) => (finalBody(run) as { calls: number }).calls),
    ).toEqual([1, 1]);
  }, 30_000);

  it("retires the child after an error frame", async () => {
    // First call throws; if the child survived it, the second call's counter
    // would read 2 and return cleanly. A fresh child throws again.
    const bundle = [
      `let calls = 0;`,
      `export default () => {`,
      `  calls += 1;`,
      `  if (calls === 1) throw new Error("boom-" + calls);`,
      `  return new Response(JSON.stringify({ calls: calls }));`,
      `};`,
    ].join("\n");

    const { runs } = await invokeSequence([
      { accountId: "acct-1", bundle: bundle },
      { accountId: "acct-1", bundle: bundle },
    ]);

    expect(terminalFrame(runs[0])?.t).toBe("error");
    expect(terminalFrame(runs[1])?.t).toBe("error");
    expect(terminalFrame(runs[1])?.error).toBe("boom-1");
  }, 30_000);

  it("retires an idle child on an unhandled rejection instead of serving another call", async () => {
    // A stray timer rejecting after the response flushed poisons the process
    // while it sits warm. The child must exit on the spot: the next call gets
    // a fresh child (counter back to 1), never a turn inside the poisoned one.
    const bundle = [
      `let calls = 0;`,
      `export default () => {`,
      `  calls += 1;`,
      `  if (calls === 1) setTimeout(() => Promise.reject(new Error("late")), 50);`,
      `  return new Response(JSON.stringify({ calls: calls }));`,
      `};`,
    ].join("\n");

    const { runs } = await invokeSequence([
      { accountId: "acct-1", bundle: bundle, waitMs: 400 },
      { accountId: "acct-1", bundle: bundle },
    ]);

    expect(
      runs.map((run) => (finalBody(run) as { calls: number }).calls),
    ).toEqual([1, 1]);
  }, 30_000);

  it("enforces the max-calls bound", async () => {
    const { runs, bundleFetches } = await invokeSequence(
      [
        { accountId: "acct-1", bundle: COUNTER_BUNDLE },
        { accountId: "acct-1", bundle: COUNTER_BUNDLE },
      ],
      { MCP_CHILD_MAX_CALLS: "1" },
    );

    expect(
      runs.map((run) => (finalBody(run) as { calls: number }).calls),
    ).toEqual([1, 1]);
    expect(bundleFetches).toBe(2);
  }, 30_000);

  it("runs one-shot when the event carries no accountId", async () => {
    const { runs, bundleFetches } = await invokeSequence([
      { bundle: COUNTER_BUNDLE },
      { bundle: COUNTER_BUNDLE },
    ]);

    expect(
      runs.map((run) => (finalBody(run) as { calls: number }).calls),
    ).toEqual([1, 1]);
    expect(bundleFetches).toBe(2);
  }, 30_000);
});
