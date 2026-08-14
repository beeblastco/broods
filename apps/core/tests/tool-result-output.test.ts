import { expect, it } from "bun:test";
import {
  modelValueToUserParts,
  normalizeToolResultOutput,
} from "../src/harness/tools/utils.ts";

it("maps native text and JSON to their matching AI SDK result types", () => {
  expect(normalizeToolResultOutput("done")).toEqual({
    type: "text",
    value: "done",
  });
  const value = { status: "completed", response: ["a", null, 1] };
  expect(normalizeToolResultOutput(value)).toEqual({
    type: "json",
    value,
  });
});

it("preserves valid explicit ToolResultOutput variants", () => {
  const denied = { type: "execution-denied" as const, reason: "not allowed" };
  expect(normalizeToolResultOutput(denied)).toBe(denied);

  const content = {
    type: "content" as const,
    value: [
      { type: "text" as const, text: "preview" },
      {
        type: "custom" as const,
        providerOptions: { provider: { mode: "preview" } },
      },
    ],
  };
  expect(normalizeToolResultOutput(content)).toBe(content);
});

it("rejects unsupported dynamic values instead of coercing them", () => {
  expect(() => normalizeToolResultOutput(1n)).toThrow(
    "Tool output must be a string",
  );
  expect(() => normalizeToolResultOutput(new Date())).toThrow(
    "Tool output must be a string",
  );
  expect(() => normalizeToolResultOutput({ value: undefined })).toThrow(
    "Tool output must be a string",
  );
  expect(() =>
    normalizeToolResultOutput({ type: "text", value: { nested: true } }),
  ).toThrow('Invalid ToolResultOutput for type "text"');
});

it("rejects cyclic JSON instead of serializing or casting it", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  expect(() => normalizeToolResultOutput(cyclic)).toThrow(
    "Tool output must be a string",
  );
});

it("adapts retained text and JSON to user text parts", () => {
  expect(modelValueToUserParts("done")).toEqual([
    { type: "text", text: "done" },
  ]);
  expect(modelValueToUserParts({ answer: 42 })).toEqual([
    { type: "text", text: '{"answer":42}' },
  ]);
  expect(modelValueToUserParts({ type: "text", value: "native text" })).toEqual(
    [{ type: "text", text: "native text" }],
  );
});

it("adapts tool content files and images to canonical user file parts", () => {
  const parts = modelValueToUserParts({
    type: "content",
    value: [
      { type: "text", text: "attachments" },
      {
        type: "file-data",
        data: "Zm9v",
        mediaType: "application/pdf",
        filename: "report.pdf",
      },
      {
        type: "image-url",
        url: "https://example.com/preview.png",
      },
    ],
  });

  expect(parts[0]).toEqual({ type: "text", text: "attachments" });
  expect(parts[1]).toEqual({
    type: "file",
    data: { type: "data", data: "Zm9v" },
    mediaType: "application/pdf",
    filename: "report.pdf",
  });
  expect(parts[2]).toEqual({
    type: "file",
    data: {
      type: "url",
      url: new URL("https://example.com/preview.png"),
    },
    mediaType: "image",
  });
});

it("keeps malformed file URLs visible as text", () => {
  expect(
    modelValueToUserParts({
      type: "content",
      value: [{ type: "image-url", url: "not a URL" }],
    }),
  ).toEqual([{ type: "text", text: '{"type":"image-url","url":"not a URL"}' }]);
});
