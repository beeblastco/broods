import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as machineExecutor from "../../../../apps/core/src/harness/sandbox/machine-executor.ts";
import {
  sendFilesTool,
  sendImagesTool,
  sendUpdateTool,
  type ChannelToolContext,
} from "../../../../apps/core/src/harness/tools/channel.tool.ts";
import computerTool from "../../../../apps/core/src/harness/tools/computer.tool.ts";
import * as filesystemUtils from "../../../../apps/core/src/harness/tools/filesystem-utils.ts";
import type { ChannelActions } from "../../../../apps/core/src/shared/channels.ts";
import type { MachineComputerResultFrame } from "../../../../apps/core/src/shared/machine-socket.ts";
import type {
  ResolvedAgentSandbox,
  ResolvedWorkspace,
} from "../../../../apps/core/src/shared/workspaces.ts";

type Spy = { mockRestore: () => void };

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const WORKSPACE: ResolvedWorkspace = {
  name: "notes",
  workspaceId: "ws_1",
  namespace: "fs-1",
  config: { storage: { provider: "s3" } },
};

let spies: Spy[] = [];
let sent: string[] = [];

afterEach((): void => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  sent = [];
});

function actions(parts: Partial<ChannelActions>): ChannelActions {
  return {
    sendText: async (text: string): Promise<void> => {
      sent.push(`text:${text}`);
    },
    sendTyping: async (): Promise<void> => {},
    reactToMessage: async (): Promise<void> => {},
    ...parts,
  };
}

function context(
  parts: Partial<ChannelActions>,
  hook: (text: string) => Promise<string | null> = async (
    text,
  ): Promise<string | null> => text,
): ChannelToolContext {
  return {
    actions: actions(parts),
    channelName: "telegram",
    transformText: hook,
    workspaces: [WORKSPACE],
    accountId: "acct_1",
  };
}

async function run(
  tools: ReturnType<typeof sendImagesTool>,
  name: string,
  input: object,
): Promise<unknown> {
  return await tools[name]?.execute?.(input, { toolCallId: "c", messages: [] });
}

describe("sendFilesTool execute", (): void => {
  test("an empty path list is refused", async (): Promise<void> => {
    await expect(
      run(sendFilesTool(context({})), "send-files", { file_paths: [] }),
    ).rejects.toThrow("needs at least one file_path");
  });

  test("a caption the outbound hook blocks sends nothing", async (): Promise<void> => {
    spies.push(
      spyOn(filesystemUtils, "workspaceMediaUrl").mockResolvedValue(
        "https://files.example.com/a.pdf",
      ),
    );
    const tools = sendFilesTool(context({}, async (): Promise<null> => null));

    expect(await run(tools, "send-files", { file_paths: ["a.pdf"] })).toBe(
      "Files blocked by the outbound message hook.",
    );
    expect(sent).toEqual([]);
  });
});

describe("sendImagesTool execute", (): void => {
  const urls = { urls: ["https://img.example.com/a.png"] };

  test("a caption the outbound hook blocks sends nothing", async (): Promise<void> => {
    const tools = sendImagesTool(
      context(
        { sendImages: async (): Promise<void> => {} },
        async (): Promise<null> => null,
      ),
    );

    expect(await run(tools, "send-images", urls)).toBe(
      "Images blocked by the outbound message hook.",
    );
  });

  test("images go out inline and are counted", async (): Promise<void> => {
    const batches: number[] = [];
    const tools = sendImagesTool(
      context({
        sendImages: async (images): Promise<void> => {
          batches.push(images.length);
        },
      }),
    );

    expect(await run(tools, "send-images", urls)).toBe(
      "1 image(s) sent to the current telegram conversation.",
    );
    expect(batches).toEqual([1]);
  });

  test("a rejected image batch falls back to files", async (): Promise<void> => {
    const tools = sendImagesTool(
      context({
        sendImages: async (): Promise<void> => {
          throw new Error("too big");
        },
        sendFiles: async (files): Promise<void> => {
          sent.push(`files:${files.length}`);
        },
      }),
    );

    expect(await run(tools, "send-images", urls)).toBe(
      "1 file(s) sent to the current telegram conversation.",
    );
    expect(sent).toEqual(["files:1"]);
  });

  test("a rejected batch with no file support falls back to links", async (): Promise<void> => {
    const tools = sendImagesTool(
      context({
        sendImages: async (): Promise<void> => {
          throw new Error("not a string");
        },
      }),
    );

    expect(await run(tools, "send-images", urls)).toContain(
      "1 download link(s) were sent as text instead",
    );
    expect(sent[0]).toContain("https://img.example.com/a.png");
  });
});

describe("sendUpdateTool execute", (): void => {
  test("an update the outbound hook blocks sends nothing", async (): Promise<void> => {
    const tools = sendUpdateTool(context({}, async (): Promise<null> => null));

    expect(await run(tools, "send-update", { message: "working" })).toBe(
      "Update blocked by the outbound message hook.",
    );
    expect(sent).toEqual([]);
  });
});

describe("computerTool execute", (): void => {
  function machine(name: string): ResolvedAgentSandbox {
    return { name: name, sandbox: { provider: "machine" } };
  }

  function reply(parts: Partial<MachineComputerResultFrame>): void {
    spies.push(
      spyOn(machineExecutor, "runMachineComputerAction").mockResolvedValue({
        type: "computer-result",
        id: "1",
        ...parts,
      }),
    );
  }

  async function act(
    machines: ResolvedAgentSandbox[],
    input: object,
  ): Promise<unknown> {
    return await computerTool(machines).computer?.execute?.(input, {
      toolCallId: "c",
      messages: [],
    });
  }

  test("several computers need an explicit choice", async (): Promise<void> => {
    await expect(
      act([machine("mac"), machine("pc")], { action: "screenshot" }),
    ).rejects.toThrow("pass sandbox with the computer to act on: mac, pc");
  });

  test("a machine error is the tool's error", async (): Promise<void> => {
    reply({ error: "screen locked" });

    await expect(
      act([machine("mac")], { action: "screenshot" }),
    ).rejects.toThrow("Error: screen locked");
  });

  test("a text answer names the computer and frontmost app", async (): Promise<void> => {
    reply({ text: "clicked", app: "Safari" });

    expect(
      await act([machine("mac"), machine("pc")], {
        action: "left_click",
        sandbox: "pc",
      }),
    ).toEqual({ type: "text", value: "clicked on pc (frontmost app: Safari)" });
  });

  test("an empty answer is OK", async (): Promise<void> => {
    reply({});

    expect(await act([machine("mac")], { action: "wait" })).toEqual({
      type: "text",
      value: "OK",
    });
  });

  test("a zoom returns the region as an image", async (): Promise<void> => {
    reply({ image: { data: ONE_PIXEL_PNG, mediaType: "image/png" } });

    expect(await act([machine("mac")], { action: "zoom" })).toEqual({
      type: "content",
      value: [
        { type: "text", text: "Zoomed region" },
        { type: "image-data", data: ONE_PIXEL_PNG, mediaType: "image/png" },
      ],
    });
  });

  test("a zoom that is not an image is described instead", async (): Promise<void> => {
    reply({ image: { data: "AAAA", mediaType: "image/png" } });

    expect(await act([machine("mac")], { action: "zoom" })).toEqual({
      type: "content",
      value: [
        { type: "text", text: "Zoomed region" },
        {
          type: "text",
          text: "[An image (image/png, 4 base64 characters) was not shown to you: it is not a PNG, JPEG, GIF or WebP image.]",
        },
      ],
    });
  });
});
