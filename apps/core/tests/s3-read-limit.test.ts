import { S3Client } from "@aws-sdk/client-s3";
import { expect, mock, spyOn, test } from "bun:test";
import { readS3Bytes, readS3TextHead } from "../src/shared/s3.ts";

test.each([
  [7 * 1024 * 1024, "7340032 bytes"],
  [undefined, "an unknown number of bytes"],
])(
  "refuses an object of %p bytes past the limit before reading it",
  async (contentLength, size): Promise<void> => {
    const read = mock(async (): Promise<Uint8Array> => new Uint8Array());
    const cancel = mock(async (): Promise<void> => {});
    const send = spyOn(S3Client.prototype, "send").mockImplementation(
      (async () => ({
        ContentLength: contentLength,
        Body: {
          transformToByteArray: read,
          transformToWebStream: () => ({ cancel: cancel }),
        },
      })) as never,
    );

    const failure = await readS3Bytes(
      "bucket",
      "ws/.broods/browse/x.png",
      undefined,
      6 * 1024 * 1024,
    ).then(
      (): string => "read",
      (error: unknown): string => String(error),
    );
    send.mockRestore();

    expect(failure).toContain(`is ${size}, over the 6291456 byte limit`);
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  },
);

test("reads only the requested head of an object", async (): Promise<void> => {
  const send = spyOn(S3Client.prototype, "send").mockImplementation(
    (async () => ({
      ContentLength: 65536,
      Body: { transformToString: async (): Promise<string> => "head" },
    })) as never,
  );

  const head = await readS3TextHead("bucket", "acct/skill/SKILL.md", 65536);
  const input = (send.mock.calls[0]?.[0] as { input: { Range?: string } })
    .input;
  send.mockRestore();

  expect(head).toBe("head");
  expect(input.Range).toBe("bytes=0-65535");
});

test("refuses a whole object from a store that ignores the range", async (): Promise<void> => {
  const read = mock(async (): Promise<string> => "");
  const cancel = mock(async (): Promise<void> => {});
  const send = spyOn(S3Client.prototype, "send").mockImplementation(
    (async () => ({
      ContentLength: 4 * 1024 * 1024,
      Body: {
        transformToString: read,
        transformToWebStream: () => ({ cancel: cancel }),
      },
    })) as never,
  );

  const failure = await readS3TextHead(
    "bucket",
    "acct/skill/SKILL.md",
    65536,
  ).then(
    (): string => "read",
    (error: unknown): string => String(error),
  );
  send.mockRestore();

  expect(failure).toContain("is 4194304 bytes, over the 65536 byte limit");
  expect(read).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalled();
});
