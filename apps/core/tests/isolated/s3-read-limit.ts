// Run on its own by browse-tool.test.ts: other test files replace shared/s3.ts
// with a mock for the whole `bun test` process, so the real module is checked
// in a process of its own.

import { S3Client } from "@aws-sdk/client-s3";
import { expect, mock, spyOn, test } from "bun:test";
import { readS3Bytes } from "../../src/shared/s3.ts";

test("refuses an object past the byte limit before reading it", async () => {
  const read = mock(async (): Promise<Uint8Array> => new Uint8Array());
  const cancel = mock(async (): Promise<void> => {});
  spyOn(S3Client.prototype, "send").mockImplementation((async () => ({
    ContentLength: 7 * 1024 * 1024,
    Body: {
      transformToByteArray: read,
      transformToWebStream: () => ({ cancel: cancel }),
    },
  })) as never);

  const failure = await readS3Bytes(
    "bucket",
    "ws/.broods/browse/x.png",
    undefined,
    6 * 1024 * 1024,
  ).then(
    (): string => "read",
    (error: unknown): string => String(error),
  );

  expect(failure).toContain("over the 6291456 byte limit");
  expect(read).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalled();
});
