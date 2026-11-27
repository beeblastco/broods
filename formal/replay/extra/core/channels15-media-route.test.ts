import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CoreRequest } from "../../../../apps/core/src/shared/http.ts";
import {
  sealMediaTicket,
  type MediaTicket,
} from "../../../../apps/core/src/shared/media-ticket.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../../../../apps/core/src/shared/storage.ts";

interface Head {
  contentLength: number;
  contentType: string | undefined;
}

const SECRET = "media-ticket-secret";
const ORIGINAL_ENV = { ...process.env };
let head: Head | null = null;

await mock.module("../../../../apps/core/src/shared/s3.ts", (): object => ({
  headS3Object: async (): Promise<Head | null> => head,
  readS3Bytes: async (): Promise<Uint8Array> => new Uint8Array([1]),
  s3ObjectExists: async (): Promise<boolean> => true,
  getS3ObjectUrl: async (): Promise<string> => "",
  readS3Text: async (): Promise<string> => "",
  listS3Prefix: async (): Promise<never[]> => [],
  writeS3Object: async (): Promise<number> => 0,
  deleteS3Object: async (): Promise<void> => {},
  deleteS3Prefix: async (): Promise<number> => 0,
  copyS3Object: async (): Promise<void> => {},
  ensureS3DirectoryMarkers: async (): Promise<void> => {},
  isMissingS3Error: (): boolean => false,
}));

const { handleMediaRequest } =
  await import("../../../../apps/core/src/media.ts");

beforeEach((): void => {
  process.env.AWS_REGION = "us-east-1";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  process.env.MEDIA_TICKET_SECRET = SECRET;
  head = null;
  setStorageForTests({
    workspaceConfigs: { getById: async (): Promise<null> => null },
  } as never);
});

afterEach((): void => {
  process.env = { ...ORIGINAL_ENV };
  resetStorageForTests();
});

function request(ticket: MediaTicket): CoreRequest {
  return {
    method: "GET",
    path: `/v1/media/${sealMediaTicket(ticket, SECRET)}`,
    search: "",
    query: new URLSearchParams(),
    headers: {},
    body: "",
    cookies: [],
    clientIp: "127.0.0.1",
  };
}

describe("locateMediaObject", (): void => {
  test("answers 404 for an attachment the store does not hold", async (): Promise<void> => {
    const response = await handleMediaRequest(
      request({ accountId: "acct_1", path: "media/ab/0-photo.png" }),
    );

    expect(response.status).toBe(404);
  });

  test("answers 404 for a workspace that no longer exists", async (): Promise<void> => {
    const response = await handleMediaRequest(
      request({
        accountId: "acct_1",
        workspaceId: "ws_gone",
        namespace: "fs-0123456789abcdef0123456789abcdef01234567",
        path: "pics/shot.png",
      }),
    );

    expect(response.status).toBe(404);
  });
});

describe("handleMediaRequest", (): void => {
  test("refuses an object over the size limit", async (): Promise<void> => {
    head = { contentLength: 26 * 1024 * 1024, contentType: undefined };

    const response = await handleMediaRequest(
      request({ accountId: "acct_1", path: "media/ab/0-big.png" }),
    );

    expect(response.status).toBe(413);
  });
});
