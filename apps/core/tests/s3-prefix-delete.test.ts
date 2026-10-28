/**
 * deleteS3Prefix against a fake bucket behind the real S3 client.
 */

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { deleteS3Prefix } from "../src/shared/s3.ts";

const BUCKET = "cleanup-bucket";
const PREFIX = "acct_cleanup/";

let keys: Set<string>;
let calls: string[];
let inFlight: number;
let peakInFlight: number;
let failures: Map<string, string[]>;

beforeEach(() => {
  keys = new Set();
  calls = [];
  inFlight = 0;
  peakInFlight = 0;
  failures = new Map();
  spyOn(S3Client.prototype, "send").mockImplementation(
    async (command: object) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Bun.sleep(1);
      inFlight -= 1;
      if (command instanceof ListObjectsV2Command) {
        calls.push("list");
        expect(command.input.Bucket).toBe(BUCKET);
        expect(command.input.Prefix).toBe(PREFIX);
        // The token is the last key of the previous page, like S3's cursor.
        const after = command.input.ContinuationToken ?? "";
        const page = [...keys]
          .filter((key) => key.startsWith(PREFIX) && key > after)
          .sort()
          .slice(0, command.input.MaxKeys);
        const more = [...keys].some(
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
      calls.push(`delete:${objects.length}`);
      expect(objects.length).toBeLessThanOrEqual(1000);
      const errors = [];
      for (const { Key: key = "" } of objects) {
        expect(key.startsWith(PREFIX)).toBe(true);
        const code = failures.get(key)?.shift();
        if (code) errors.push({ Key: key, Code: code, Message: code });
        else keys.delete(key);
      }

      return errors.length > 0 ? { Errors: errors } : {};
    },
  );
});

afterEach(() => {
  spyOn(S3Client.prototype, "send").mockRestore();
  spyOn(Bun, "sleep").mockRestore();
});

function fill(count: number): void {
  for (let index = 0; index < count; index += 1) {
    keys.add(`${PREFIX}${String(index).padStart(5, "0")}`);
  }
  keys.add("acct_cleanup-neighbour/keep");
}

// The retry tests check which keys go again, not how long the backoff is, so
// they skip its waits.
function skipBackoff(): void {
  spyOn(Bun, "sleep").mockResolvedValue(undefined);
}

test("deletes 2,001 keys a page at a time, one request in flight", async (): Promise<void> => {
  fill(2001);

  expect(await deleteS3Prefix(BUCKET, PREFIX)).toBe(2001);
  expect(keys).toEqual(new Set(["acct_cleanup-neighbour/keep"]));
  expect(calls).toEqual([
    "list",
    "delete:1000",
    "list",
    "delete:1000",
    "list",
    "delete:1",
  ]);
  expect(peakInFlight).toBe(1);
});

test("an empty prefix lists once and deletes nothing", async (): Promise<void> => {
  expect(await deleteS3Prefix(BUCKET, PREFIX)).toBe(0);
  expect(calls).toEqual(["list"]);
});

test("a key the store refuses fails the cleanup and stops it", async (): Promise<void> => {
  fill(1500);
  failures.set(`${PREFIX}00007`, ["AccessDenied"]);

  const failure = await deleteS3Prefix(BUCKET, PREFIX).then(
    (count): string => `deleted ${count}`,
    (error: unknown): string => String(error),
  );

  expect(failure).toContain(`1 of 1000 objects under ${PREFIX}`);
  expect(failure).toContain(`${PREFIX}00007: AccessDenied`);
  expect(calls).toEqual(["list", "delete:1000"]);
  expect(keys.has(`${PREFIX}00007`)).toBe(true);
});

test("retries only the keys that hit a transient error", async (): Promise<void> => {
  skipBackoff();
  fill(3);
  failures.set(`${PREFIX}00001`, ["SlowDown", "InternalError"]);

  expect(await deleteS3Prefix(BUCKET, PREFIX)).toBe(3);
  expect(calls).toEqual(["list", "delete:3", "delete:1", "delete:1"]);
  expect(keys).toEqual(new Set(["acct_cleanup-neighbour/keep"]));
});

test("gives up on a key still failing after three attempts", async (): Promise<void> => {
  skipBackoff();
  fill(2);
  failures.set(`${PREFIX}00000`, ["SlowDown", "SlowDown", "SlowDown"]);

  const failure = await deleteS3Prefix(BUCKET, PREFIX).then(
    (count): string => `deleted ${count}`,
    (error: unknown): string => String(error),
  );

  expect(failure).toContain(`${PREFIX}00000: SlowDown`);
  expect(calls).toEqual(["list", "delete:2", "delete:1", "delete:1"]);
});
