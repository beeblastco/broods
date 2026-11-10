import { S3Client } from "@aws-sdk/client-s3";
import { expect, mock, spyOn, test } from "bun:test";
import {
  s3ReadNumbered,
  workspaceMediaBytes,
} from "../src/harness/tools/filesystem-utils.ts";
import readTool from "../src/harness/tools/read.tool.ts";
import type { ResolvedWorkspace } from "../src/shared/workspaces.ts";

const workspace: ResolvedWorkspace = {
  name: "docs",
  workspaceId: "ws_1",
  namespace: "acct/ws_1",
  config: { storage: { provider: "s3" } },
};

const readTools = readTool({
  workspaces: [workspace],
  agentConfig: { model: { provider: "openai", modelId: "test-model" } },
});

test.each([
  [
    "send-files",
    "big.png",
    workspaceMediaBytes,
    "over the 26214400 byte limit",
  ],
  [
    "read-only text read",
    "big.log",
    s3ReadNumbered,
    "big.log is over the 25 MB a workspace without a sandbox can read",
  ],
  [
    "audio read",
    "big.wav",
    async (_ws: ResolvedWorkspace, rel: string): Promise<unknown> =>
      await readTools.read?.execute?.({ file_path: rel } as never, {
        toolCallId: "call_1",
        messages: [],
        context: undefined,
      }),
    "big.wav is over the 25 MB of audio the read tool transcribes",
  ],
])(
  "refuses a 2 GB workspace file on the %s path before buffering it",
  async (_path, rel, read, refusal): Promise<void> => {
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

    expect(failure).toContain(refusal);
    expect(buffer).not.toHaveBeenCalled();
  },
);
