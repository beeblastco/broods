/**
 * Public media route tests.
 * The sealed ticket is the only credential, so cover what it opens and what it refuses.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { CoreRequest } from "../src/shared/http.ts";
import { sealMediaTicket } from "../src/shared/media-ticket.ts";
import {
  resetStorageForTests,
  setStorageForTests,
  type Storage,
} from "../src/shared/storage.ts";

const headS3ObjectMock = mock(async (_bucket: string, _key: string) => ({
  contentLength: 12,
  contentType: undefined as string | undefined,
}));
const readS3BytesMock = mock(
  async (_bucket: string, _key: string) => new Uint8Array([1, 2, 3]),
);

mock.module("../src/shared/s3.ts", () => ({
  headS3Object: headS3ObjectMock,
  readS3Bytes: readS3BytesMock,
  // Full surface so transitive importers keep working (mock.module replaces the module).
  s3ObjectExists: mock(async () => true),
  getS3ObjectUrl: mock(async () => "https://signed.example/photo"),
  readS3Text: mock(async () => ""),
  listS3Prefix: mock(async () => []),
  writeS3Object: mock(async () => 0),
  deleteS3Object: mock(async () => {}),
  deleteS3Prefix: mock(async () => 0),
  copyS3Object: mock(async () => {}),
  ensureS3DirectoryMarkers: mock(async () => {}),
  isMissingS3Error: () => false,
}));

const ORIGINAL_ENV = { ...process.env };
const ACCOUNT = "acct_1";
const NS = "fs-0123456789abcdef0123456789abcdef01234567";
const SECRET = "service-auth-secret";

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  process.env.SERVICE_AUTH_SECRET = SECRET;
  headS3ObjectMock.mockClear();
  readS3BytesMock.mockClear();
  headS3ObjectMock.mockImplementation(async () => ({
    contentLength: 12,
    contentType: undefined,
  }));
  setStorageForTests(storageWithWorkspace());
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetStorageForTests();
});

describe("handleMediaRequest", () => {
  it("serves the workspace file a ticket names", async (): Promise<void> => {
    const { handleMediaRequest } = await import("../src/media.ts");

    const response = await handleMediaRequest(mediaRequest(ticket()));

    expect(response.status).toBe(200);
    // No stored content type on a file written through the sandbox mount, so the
    // extension is what keeps the provider from treating it as a download.
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(headS3ObjectMock.mock.calls[0]).toEqual([
      "filesystem-bucket",
      `${NS}/pics/shot.png`,
    ]);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("answers a HEAD without reading the body", async (): Promise<void> => {
    const { handleMediaRequest } = await import("../src/media.ts");

    const response = await handleMediaRequest({
      ...mediaRequest(ticket()),
      method: "HEAD",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("12");
    expect(readS3BytesMock).not.toHaveBeenCalled();
  });

  it("refuses a ticket sealed with another secret", async (): Promise<void> => {
    const { handleMediaRequest } = await import("../src/media.ts");
    const forged = sealMediaTicket(
      {
        accountId: ACCOUNT,
        workspaceId: "ws_a",
        namespace: NS,
        path: "pics/shot.png",
      },
      "not-the-service-secret",
    );

    const response = await handleMediaRequest(mediaRequest(forged));

    expect(response.status).toBe(404);
    expect(readS3BytesMock).not.toHaveBeenCalled();
  });

  it("types the response from the extension, not from the stored object", async (): Promise<void> => {
    const { handleMediaRequest } = await import("../src/media.ts");
    // An account on a bring-your-own bucket sets this itself, so serving it back
    // would let it host text/html on our own unauthenticated origin.
    headS3ObjectMock.mockImplementation(async () => ({
      contentLength: 12,
      contentType: "text/html",
    }));

    const response = await handleMediaRequest(mediaRequest(ticket()));

    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sends an SVG as an attachment so it cannot script this origin", async (): Promise<void> => {
    const { handleMediaRequest } = await import("../src/media.ts");
    const svg = sealMediaTicket(
      {
        accountId: ACCOUNT,
        workspaceId: "ws_a",
        namespace: NS,
        path: "pics/logo.svg",
      },
      SECRET,
    );

    const response = await handleMediaRequest(mediaRequest(svg));

    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-disposition")).toBe("attachment");
  });

  it("404s once the file is gone", async (): Promise<void> => {
    const { handleMediaRequest } = await import("../src/media.ts");
    headS3ObjectMock.mockImplementation(async () => null as never);

    const response = await handleMediaRequest(mediaRequest(ticket()));

    expect(response.status).toBe(404);
    expect(readS3BytesMock).not.toHaveBeenCalled();
  });
});

describe("routesToMedia", () => {
  it("claims media reads only", async (): Promise<void> => {
    const { routesToMedia } = await import("../src/media.ts");

    expect(routesToMedia("GET", "/media/abc")).toBe(true);
    expect(routesToMedia("HEAD", "/media/abc")).toBe(true);
    expect(routesToMedia("POST", "/media/abc")).toBe(false);
    expect(routesToMedia("GET", "/v1/agents")).toBe(false);
  });
});

function mediaRequest(token: string): CoreRequest {
  return {
    method: "GET",
    path: `/media/${token}`,
    search: "",
    query: new URLSearchParams(),
    headers: {},
    body: "",
    cookies: [],
    clientIp: "203.0.113.1",
  };
}

function storageWithWorkspace(): Storage {
  return {
    workspaceConfigs: {
      getById: async function (accountId: string, workspaceId: string) {
        return accountId === ACCOUNT && workspaceId === "ws_a"
          ? { config: { storage: { provider: "s3" } } }
          : null;
      },
    },
  } as never;
}

function ticket(): string {
  return sealMediaTicket(
    {
      accountId: ACCOUNT,
      workspaceId: "ws_a",
      namespace: NS,
      path: "pics/shot.png",
    },
    SECRET,
  );
}
