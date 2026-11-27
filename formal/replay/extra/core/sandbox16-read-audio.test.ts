import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as filesystemUtils from "../../../../apps/core/src/harness/tools/filesystem-utils.ts";
import readTool from "../../../../apps/core/src/harness/tools/read.tool.ts";
import type { SandboxToolContext } from "../../../../apps/core/src/harness/tools/filesystem-utils.ts";
import * as transcribe from "../../../../apps/core/src/harness/transcribe.ts";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";
import type { ResolvedWorkspace } from "../../../../apps/core/src/shared/workspaces.ts";

type Spy = { mockRestore: () => void };

const WORKSPACE: ResolvedWorkspace = {
  name: "notes",
  workspaceId: "ws_1",
  namespace: "fs-1",
  config: { storage: { provider: "s3" } },
};

const AGENT = { model: { provider: "openai" } } as unknown as AgentConfig;

let spies: Spy[] = [];

afterEach((): void => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
});

async function readAudio(): Promise<unknown> {
  const context: SandboxToolContext = {
    workspaces: [WORKSPACE],
    agentConfig: AGENT,
  };
  const read = readTool(context).read;

  return await read?.execute?.(
    { file_path: "voice/note.mp3" },
    { toolCallId: "call_1", messages: [] },
  );
}

describe("spokenContents", (): void => {
  test("an unreadable recording falls through to the line reader", async (): Promise<void> => {
    spies.push(
      spyOn(filesystemUtils, "workspaceMediaBytes").mockRejectedValue(
        new Error("missing"),
      ),
      spyOn(filesystemUtils, "s3ReadNumbered").mockResolvedValue("1\tplain"),
    );

    expect(await readAudio()).toBe("1\tplain");
  });

  test("an empty recording falls through to the line reader", async (): Promise<void> => {
    spies.push(
      spyOn(filesystemUtils, "workspaceMediaBytes").mockResolvedValue(
        undefined as unknown as Uint8Array,
      ),
      spyOn(filesystemUtils, "s3ReadNumbered").mockResolvedValue("1\tplain"),
    );

    expect(await readAudio()).toBe("1\tplain");
  });

  test("a refused transcription is an error with advice", async (): Promise<void> => {
    spies.push(
      spyOn(filesystemUtils, "workspaceMediaBytes").mockResolvedValue(
        new Uint8Array([1, 2]),
      ),
      spyOn(transcribe, "transcribeAudio").mockResolvedValue({
        status: "failed",
        reason: "bad format",
        recovery: "unavailable",
      }),
    );

    await expect(readAudio()).rejects.toThrow(
      "Error: voice/note.mp3 could not be transcribed: bad format. Reading it again will not help; ask what was said.",
    );
  });

  test("a transcript is returned with its path", async (): Promise<void> => {
    spies.push(
      spyOn(filesystemUtils, "workspaceMediaBytes").mockResolvedValue(
        new Uint8Array([1, 2]),
      ),
      spyOn(transcribe, "transcribeAudio").mockResolvedValue({
        status: "transcribed",
        text: "hello there",
      }),
    );

    expect(await readAudio()).toBe(
      "Transcript of voice/note.mp3:\n\nhello there",
    );
  });

  test("a silent recording says it has no speech", async (): Promise<void> => {
    spies.push(
      spyOn(filesystemUtils, "workspaceMediaBytes").mockResolvedValue(
        new Uint8Array([1, 2]),
      ),
      spyOn(transcribe, "transcribeAudio").mockResolvedValue({
        status: "transcribed",
        text: "",
      }),
    );

    expect(await readAudio()).toBe("voice/note.mp3 contains no speech.");
  });
});
