import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deleteS3Prefix } from "../model/s3";

const BUCKET = "cleanup-bucket";
const PREFIX = "acct_cleanup/skill/";

const fake = vi.hoisted(() => ({
  keys: new Set<string>(),
  calls: [] as string[],
  inFlight: 0,
  peakInFlight: 0,
  failures: new Map<string, string[]>(),
}));

vi.mock("../model/aws", () => ({
  s3Client: vi.fn(async () => ({
    send: async (command: object) => {
      fake.inFlight += 1;
      fake.peakInFlight = Math.max(fake.peakInFlight, fake.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      fake.inFlight -= 1;
      if (command instanceof ListObjectsV2Command) {
        fake.calls.push("list");
        expect(command.input).toMatchObject({ Bucket: BUCKET, Prefix: PREFIX });
        // The token is the last key of the previous page, like S3's cursor.
        const after = command.input.ContinuationToken ?? "";
        const page = [...fake.keys]
          .filter((key) => key.startsWith(PREFIX) && key > after)
          .sort()
          .slice(0, command.input.MaxKeys);
        const more = [...fake.keys].some(
          (key) => key.startsWith(PREFIX) && key > (page.at(-1) ?? ""),
        );

        return {
          Contents: page.map((key) => ({ Key: key })),
          ...(more ? { NextContinuationToken: page.at(-1) } : {}),
        };
      }
      if (!(command instanceof DeleteObjectsCommand)) {
        throw new Error(`unexpected ${command.constructor.name}`);
      }
      expect(command.input.Bucket).toBe(BUCKET);
      const objects = command.input.Delete?.Objects ?? [];
      fake.calls.push(`delete:${objects.length}`);
      expect(objects.length).toBeLessThanOrEqual(1000);
      const errors = [];
      for (const { Key: key = "" } of objects) {
        expect(key.startsWith(PREFIX)).toBe(true);
        const code = fake.failures.get(key)?.shift();
        if (code) errors.push({ Key: key, Code: code, Message: code });
        else fake.keys.delete(key);
      }

      return errors.length > 0 ? { Errors: errors } : {};
    },
  })),
}));

beforeEach(() => {
  fake.keys.clear();
  fake.calls.length = 0;
  fake.inFlight = 0;
  fake.peakInFlight = 0;
  fake.failures.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

function fill(count: number): void {
  for (let index = 0; index < count; index += 1) {
    fake.keys.add(`${PREFIX}${String(index).padStart(5, "0")}`);
  }
  fake.keys.add("acct_cleanup/skill-neighbour/keep");
}

test("deletes 2,001 keys a page at a time, one request in flight", async () => {
  fill(2001);

  expect(await deleteS3Prefix(BUCKET, PREFIX)).toBe(2001);
  expect(fake.keys).toEqual(new Set(["acct_cleanup/skill-neighbour/keep"]));
  expect(fake.calls).toEqual([
    "list",
    "delete:1000",
    "list",
    "delete:1000",
    "list",
    "delete:1",
  ]);
  expect(fake.peakInFlight).toBe(1);
});

test("an empty prefix lists once and deletes nothing", async () => {
  expect(await deleteS3Prefix(BUCKET, PREFIX)).toBe(0);
  expect(fake.calls).toEqual(["list"]);
});

test("a key the store refuses fails the cleanup and stops it", async () => {
  fill(1500);
  fake.failures.set(`${PREFIX}00007`, ["AccessDenied"]);

  await expect(deleteS3Prefix(BUCKET, PREFIX)).rejects.toThrow(
    `1 of 1000 objects under ${PREFIX} in ${BUCKET}, first ${PREFIX}00007: AccessDenied`,
  );
  expect(fake.calls).toEqual(["list", "delete:1000"]);
  expect(fake.keys.has(`${PREFIX}00007`)).toBe(true);
});

// The retry tests check which keys go again, not how long the backoff is, so
// they run its waits on a fake clock.
test("retries only the keys that hit a transient error", async () => {
  vi.useFakeTimers();
  fill(3);
  fake.failures.set(`${PREFIX}00001`, ["SlowDown", "InternalError"]);

  const deleted = deleteS3Prefix(BUCKET, PREFIX);
  await vi.runAllTimersAsync();
  expect(await deleted).toBe(3);
  expect(fake.calls).toEqual(["list", "delete:3", "delete:1", "delete:1"]);
  expect(fake.keys).toEqual(new Set(["acct_cleanup/skill-neighbour/keep"]));
});

test("gives up on a key still failing after three attempts", async () => {
  vi.useFakeTimers();
  fill(2);
  fake.failures.set(`${PREFIX}00000`, ["SlowDown", "SlowDown", "SlowDown"]);

  await Promise.all([
    expect(deleteS3Prefix(BUCKET, PREFIX)).rejects.toThrow(
      `${PREFIX}00000: SlowDown`,
    ),
    vi.runAllTimersAsync(),
  ]);
  expect(fake.calls).toEqual(["list", "delete:2", "delete:1", "delete:1"]);
});
