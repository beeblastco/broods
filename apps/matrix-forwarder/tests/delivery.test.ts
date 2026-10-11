/**
 * What the stored sync token does when core does not take an event. Each case
 * runs `fixtures/delivery.ts` in its own process; that file says why.
 *
 * `tokensAtSync` is the sync token on disk as each `/sync` arrived: the first
 * sync finds none, the second runs from `s1` and serves the message, the third
 * from `s2` serves nothing new, and the account then waits on `s3`.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

interface DeliveryRun {
  deliveries: number[];
  tokensAtSync: string[];
}

describe("a message core does not take", () => {
  it("keeps the stored token behind it until a retry lands", async () => {
    expect(await run("transient")).toEqual({
      deliveries: [503, 200],
      tokensAtSync: ["", "s1", "s1", "s3"],
    });
  });

  it("is served again to a restarted account", async () => {
    expect(await run("restart")).toEqual({
      deliveries: [503, 503, 200],
      // The second account starts from s1, gets the message again, and moves on.
      tokensAtSync: ["", "s1", "s1", "s1", "s1", "s2", "s3"],
    });
  });

  it("is dropped on a 4xx, which answers the same every time", async () => {
    expect(await run("rejected")).toEqual({
      deliveries: [404],
      tokensAtSync: ["", "s1", "s2", "s3"],
    });
  });

  it("is dropped once its retry window passes, so the account moves on", async () => {
    expect(await run("expired")).toEqual({
      deliveries: [503],
      tokensAtSync: ["", "s1", "s1", "s3"],
    });
  });
});

async function run(mode: string): Promise<DeliveryRun> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/delivery.ts"), mode],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  // The account's own log lines share stdout.
  const line = stdout
    .split("\n")
    .find((candidate): boolean => candidate.startsWith('{"deliveries"'));
  const result: DeliveryRun = JSON.parse(line ?? "null");

  return result;
}
