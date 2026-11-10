import { S3Client } from "@aws-sdk/client-s3";
import { expect, mock, spyOn, test } from "bun:test";
import {
  s3ReadNumbered,
  workspaceMediaBytes,
} from "../src/harness/tools/filesystem-utils.ts";
import type { ResolvedWorkspace } from "../src/shared/workspaces.ts";

const workspace: ResolvedWorkspace = {
  name: "docs",
  workspaceId: "ws_1",
  namespace: "acct/ws_1",
  config: { storage: { provider: "s3" } },
};

test.each([
  ["send-files and audio read", "big.wav", workspaceMediaBytes],
  ["read-only text read", "big.log", s3ReadNumbered],
])(
  "refuses a 2 GB workspace file on the %s path before buffering it",
  async (_path, rel, read): Promise<void> => {
    process.env.FILESYSTEM_BUCKET_NAME = "bucket";
    const buffer = mock(async (): Promise<never> => {
      throw new Error("buffered the whole object");
    });
    const send = spyOn(S3Client.prototype, "send").mockImplementation(
      (async () => ({
        ContentLength: 2 * 1024 * 1024 * 1024,
        Body: {
          transformToByteArray: buffer,
          transformToString: buffer,
          transformToWebStream: () => ({
            cancel: async (): Promise<void> => {},
          }),
        },
      })) as never,
    );

    const failure = await read(workspace, rel).then(
      (): string => "read",
      (error: unknown): string => String(error),
    );
    send.mockRestore();

    expect(failure).toContain("over the 26214400 byte limit");
    expect(buffer).not.toHaveBeenCalled();
  },
);
