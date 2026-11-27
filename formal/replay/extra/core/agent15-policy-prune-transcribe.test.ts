import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";

import {
  applyMessageSendingHook,
  type HookDispatcher,
} from "../../../../apps/core/src/harness/hook-dispatcher.ts";
import { policyInputForTool } from "../../../../apps/core/src/harness/policy.ts";
import { pruneSessionMessages } from "../../../../apps/core/src/harness/pruning.ts";
import { transcribeAudio } from "../../../../apps/core/src/harness/transcribe.ts";
import type { ResolvedWorkspace } from "../../../../apps/core/src/shared/workspaces.ts";

const realFetch = globalThis.fetch;

afterEach((): void => {
  globalThis.fetch = realFetch;
});

describe("policyInputForTool", (): void => {
  const workspaces = [
    { name: "notes", workspaceId: "ws_1", namespace: "notes-ns" },
  ] as unknown as ResolvedWorkspace[];

  test("names no workspace when the one asked for does not exist", (): void => {
    const decision = policyInputForTool(
      "read",
      { file_path: "a.txt", workspace: "ghost" },
      workspaces,
    );

    expect(decision.workspaceId).toBeUndefined();
    expect(decision.workspaceName).toBeUndefined();
  });

  test("previews scalars, arrays and objects of the input", (): void => {
    const decision = policyInputForTool(
      "custom",
      { c: 3, d: true, e: [1, 2], f: { g: 1 } },
      workspaces,
    );

    expect(decision.tool?.inputPreview).toContain("c=3");
    expect(decision.tool?.inputPreview).toContain("e=[array:2]");
    expect(decision.tool?.inputPreview).toContain("f={object}");
  });

  test("keeps no tool context for an input that is not an object", (): void => {
    expect(policyInputForTool("custom", "text", workspaces).tool).toEqual({});
    expect(policyInputForTool("custom", [1], workspaces).tool).toEqual({});
  });
});

describe("pruneSessionMessages", (): void => {
  test("shows an earlier tool image again in a user message", (): void => {
    const messages: ModelMessage[] = [
      { role: "user", content: "look" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "shot",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "shot",
            output: {
              type: "content",
              value: [
                { type: "image-data", data: "AAAA", mediaType: "image/png" },
              ],
            },
          },
        ],
      },
      { role: "assistant", content: "seen" },
      { role: "user", content: "again" },
    ];
    const pruned = pruneSessionMessages(messages, {
      model: { provider: "anthropic", modelId: "claude-test" },
    });
    const shown = pruned.find(
      (message): boolean =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((part): boolean => part.type === "image"),
    );

    expect(shown).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Images a tool returned earlier:" },
        { type: "image", image: "AAAA", mediaType: "image/png" },
      ],
    });
  });
});

describe("applyMessageSendingHook", (): void => {
  test("drops a message the hook drops", async (): Promise<void> => {
    const hooks: HookDispatcher = {
      hasHooksFor: (): boolean => true,
      runMutation: async (): Promise<Record<string, unknown>> => ({
        drop: true,
      }),
    };

    expect(await applyMessageSendingHook(hooks, "slack", "hello")).toBeNull();
  });
});

describe("transcribeAudio", (): void => {
  test("fails as unavailable when the provider has no transcription model", async (): Promise<void> => {
    expect(await transcribeAudio({}, new Uint8Array([1]), 0)).toEqual({
      status: "failed",
      reason: "this provider has no transcription model",
      recovery: "unavailable",
    });
  });

  test("hands the audio to the provider's model and reports a refusal", async (): Promise<void> => {
    globalThis.fetch = Object.assign(
      async (): Promise<Response> =>
        Response.json({ error: { message: "bad audio" } }, { status: 400 }),
      { preconnect: realFetch.preconnect },
    );
    const outcome = await transcribeAudio(
      {
        model: { provider: "openai", modelId: "gpt-test" },
        provider: { openai: { apiKey: "key-one" } },
      },
      new Uint8Array([1, 2]),
      0,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      recovery: "unsupported",
    });
  });
});
