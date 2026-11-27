import { describe, expect, test } from "bun:test";
import type { ImagePart, ModelMessage } from "ai";

import {
  ATTACHMENT_NOT_RETAINED,
  createStoredEventFromModelMessage,
} from "../../../../apps/core/src/harness/session.ts";

function storedParts(image: ImagePart["image"]): unknown {
  const message: ModelMessage = {
    role: "user",
    content: [{ type: "image", image: image }],
  };
  const event = createStoredEventFromModelMessage(message, "source_1");
  const stored = event?.message as { content: unknown } | undefined;

  return stored?.content;
}

describe("isStorableMediaReference", (): void => {
  test("keeps an image given as an http URL object", (): void => {
    const image = new URL("https://media.example.com/a.png");

    expect(storedParts(image)).toEqual([{ type: "image", image: image }]);
  });

  test("keeps an image wrapped as a typed url", (): void => {
    const wrapped = {
      type: "url",
      url: new URL("https://media.example.com/b.png"),
    } as unknown as ImagePart["image"];

    expect(storedParts(wrapped)).toEqual([{ type: "image", image: wrapped }]);
  });

  test("drops an image URL object that is not http", (): void => {
    expect(storedParts(new URL("data:image/png;base64,AAAA"))).toEqual([
      { type: "text", text: ATTACHMENT_NOT_RETAINED },
    ]);
  });

  test("drops raw image bytes", (): void => {
    expect(storedParts(new Uint8Array([1, 2, 3]))).toEqual([
      { type: "text", text: ATTACHMENT_NOT_RETAINED },
    ]);
  });
});
