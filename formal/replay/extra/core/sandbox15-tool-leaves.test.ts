import { describe, expect, test } from "bun:test";

import {
  sandboxRunMetadata,
  type SandboxToolContext,
} from "../../../../apps/core/src/harness/tools/filesystem-utils.ts";
import {
  MAX_RESULT_IMAGES,
  withImageLimits,
} from "../../../../apps/core/src/harness/tools/utils.ts";
import type { ResolvedWorkspace } from "../../../../apps/core/src/shared/workspaces.ts";

type ToolParts = Parameters<typeof withImageLimits>[0];

const WORKSPACE: ResolvedWorkspace = {
  name: "notes",
  workspaceId: "ws_1",
  namespace: "fs-1",
  config: { storage: { provider: "s3" } },
};

function pngPart(width: number, height: number): ToolParts[number] {
  const bytes = Buffer.alloc(33);
  bytes.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);

  return {
    type: "image-data",
    data: bytes.toString("base64"),
    mediaType: "image/png",
  };
}

describe("withImageLimits", (): void => {
  test("text passes through and a small PNG is kept", (): void => {
    const text: ToolParts[number] = { type: "text", text: "hello" };
    const parts = withImageLimits([text, pngPart(2, 3)]);
    expect(parts[0]).toEqual(text);
    expect(parts[1]?.type).toBe("image-data");
  });

  test("a side over the limit is refused", (): void => {
    expect(withImageLimits([pngPart(9000, 10)])[0]?.type).toBe("text");
    expect(withImageLimits([pngPart(10, 0)])[0]?.type).toBe("text");
  });

  test("only the first images of one result are shown", (): void => {
    const parts = withImageLimits(
      Array.from({ length: MAX_RESULT_IMAGES + 1 }, (): ToolParts[number] =>
        pngPart(1, 1),
      ),
    );
    expect(parts.filter((part) => part.type === "image-data")).toHaveLength(
      MAX_RESULT_IMAGES,
    );
    expect(parts.at(-1)?.type).toBe("text");
  });

  test("a PNG cut off before its header is refused", (): void => {
    const cut: ToolParts[number] = {
      type: "image-data",
      data: Buffer.from("\x89PNG\r\n\x1a\nabcd", "latin1").toString("base64"),
      mediaType: "image/png",
    };
    expect(withImageLimits([cut])[0]?.type).toBe("text");
  });
});

describe("sandboxRunMetadata", (): void => {
  test("is absent when the context carries none", (): void => {
    const context: SandboxToolContext = { workspaces: [] };
    expect(sandboxRunMetadata(context, WORKSPACE)).toBeUndefined();
  });

  test("copies the context's metadata", (): void => {
    const context: SandboxToolContext = {
      workspaces: [],
      sandboxMetadata: { agentId: "agent_1", traceId: "trace_1" },
    };
    expect(sandboxRunMetadata(context)).toEqual({
      agentId: "agent_1",
      traceId: "trace_1",
    });
  });

  test("adds the workspace it runs in", (): void => {
    const context: SandboxToolContext = {
      workspaces: [WORKSPACE],
      sandboxMetadata: { agentId: "agent_1" },
    };
    expect(sandboxRunMetadata(context, WORKSPACE)).toEqual({
      agentId: "agent_1",
      workspaceName: "notes",
      workspaceId: "ws_1",
    });
  });
});
