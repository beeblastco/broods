import { describe, expect, test } from "bun:test";

import {
  getOwnedSubagent,
  modelValueToUserParts,
  withImageLimits,
  type SubagentToolContext,
} from "../../../../apps/core/src/harness/tools/utils.ts";
import { createSubagentTaskId } from "../../../../apps/core/src/shared/runtime-keys.ts";

type ToolParts = Parameters<typeof withImageLimits>[0];
type Output = Parameters<typeof modelValueToUserParts>[0];

function base64Of(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64");
}

function imagePart(bytes: number[]): ToolParts[number] {
  return {
    type: "image-data",
    data: base64Of(bytes),
    mediaType: "image/png",
  };
}

describe("modelValueToUserParts", (): void => {
  test("a JSON output becomes its text", (): void => {
    expect(
      modelValueToUserParts({ type: "json", value: { count: 2 } }),
    ).toEqual([{ type: "text", text: '{"count":2}' }]);
  });

  test("a denied execution keeps its reason", (): void => {
    expect(
      modelValueToUserParts({ type: "execution-denied", reason: "no" }),
    ).toEqual([{ type: "text", text: "Execution denied: no" }]);
    expect(modelValueToUserParts({ type: "execution-denied" })).toEqual([
      { type: "text", text: "Execution denied" },
    ]);
  });
});

describe("toolContentPartToUserPart", (): void => {
  function contentOf(...value: object[]): Output {
    return { type: "content", value: value } as unknown as Output;
  }

  test("a file part keeps its data, name and options", (): void => {
    expect(
      modelValueToUserParts(
        contentOf({
          type: "file",
          data: { type: "url", url: new URL("https://example.com/a.pdf") },
          mediaType: "application/pdf",
          filename: "a.pdf",
        }),
      ),
    ).toEqual([
      {
        type: "file",
        data: { type: "url", url: new URL("https://example.com/a.pdf") },
        mediaType: "application/pdf",
        filename: "a.pdf",
      },
    ]);
  });

  test("a provider file reference becomes a tagged reference", (): void => {
    expect(
      modelValueToUserParts(
        contentOf(
          { type: "file-reference", providerReference: { openai: "file_1" } },
          {
            type: "image-file-reference",
            providerReference: { openai: "file_2" },
          },
        ),
      ),
    ).toEqual([
      {
        type: "file",
        data: { type: "reference", reference: { openai: "file_1" } },
        mediaType: "application/octet-stream",
      },
      {
        type: "file",
        data: { type: "reference", reference: { openai: "file_2" } },
        mediaType: "image",
      },
    ]);
  });

  test("a string file id stays as text and a keyed one becomes a reference", (): void => {
    expect(
      modelValueToUserParts(
        contentOf(
          { type: "file-id", fileId: "file_1" },
          { type: "image-file-id", fileId: { openai: "file_2" } },
        ),
      ),
    ).toEqual([
      { type: "text", text: '{"type":"file-id","fileId":"file_1"}' },
      {
        type: "file",
        data: { type: "reference", reference: { openai: "file_2" } },
        mediaType: "image",
      },
    ]);
  });

  test("a custom part stays as text", (): void => {
    expect(modelValueToUserParts(contentOf({ type: "custom" }))).toEqual([
      { type: "text", text: '{"type":"custom"}' },
    ]);
  });
});

describe("withImageLimits", (): void => {
  test("bytes that are no known image are refused", (): void => {
    const parts = withImageLimits([imagePart([1, 2, 3, 4, 5, 6])]);

    expect(parts[0]).toMatchObject({ type: "text" });
  });

  test("a GIF is sized from its header", (): void => {
    const gif = [...Buffer.from("GIF89a"), 3, 0, 4, 0, 0, 0];
    const parts = withImageLimits([imagePart(gif)]);

    expect(parts[0]).toMatchObject({
      type: "image-data",
      mediaType: "image/gif",
    });
  });

  test("a GIF cut inside its header is refused", (): void => {
    const parts = withImageLimits([imagePart([...Buffer.from("GIF89a")])]);

    expect(parts[0]).toMatchObject({ type: "text" });
  });

  test("a JPEG is sized after skipping its other segments", (): void => {
    const jpeg = [
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 5, 0, 7, 1,
      1, 0x11, 0,
    ];
    const parts = withImageLimits([imagePart(jpeg)]);

    expect(parts[0]).toMatchObject({
      type: "image-data",
      mediaType: "image/jpeg",
    });
  });

  test("a JPEG with no frame header is refused", (): void => {
    const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xd9, 0, 0, 0, 0];
    const parts = withImageLimits([imagePart(jpeg)]);

    expect(parts[0]).toMatchObject({ type: "text" });
  });
});

describe("startedInConversation", (): void => {
  test("a task started under another account is not owned", async (): Promise<void> => {
    const context = {
      accountId: "acct_1",
      eventId: "acct:acct_1:agent:a1:evt1",
      conversationKey: "acct:acct_1:agent:a1:conv",
    } as unknown as SubagentToolContext;
    const taskId = createSubagentTaskId(
      "acct:acct_2:agent:a1:evt1",
      "123e4567-e89b-12d3-a456-426614174000",
    );

    expect(
      await getOwnedSubagent(context, { taskId: taskId, agentId: "a1" }),
    ).toBeNull();
  });
});
