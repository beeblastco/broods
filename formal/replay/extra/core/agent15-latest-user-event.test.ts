import { afterEach, describe, expect, test } from "bun:test";

import {
  ingestChannelAttachments,
  type ConversationIngressEvent,
} from "../../../../apps/core/src/harness/session.ts";
import { setStorageForTests } from "../../../../apps/core/src/shared/storage.ts";

const REFUSED_NOTE =
  "photo.png (image/png) could not be read: download refused";

afterEach((): void => {
  setStorageForTests(null);
});

async function ingest(
  events: ConversationIngressEvent[],
): Promise<Awaited<ReturnType<typeof ingestChannelAttachments>>> {
  setStorageForTests({
    sandboxConfigs: { getById: async (): Promise<null> => null },
    workspaceConfigs: {
      getById: async (): Promise<unknown> => ({
        config: { storage: { provider: "s3" }, isolation: "agent" },
      }),
    },
  } as never);

  return ingestChannelAttachments(
    events,
    [
      {
        type: "image",
        name: "photo.png",
        mimeType: "image/png",
        fetchData: async (): Promise<Buffer> => {
          throw new Error("download refused");
        },
      },
    ],
    {
      accountId: "acct_1",
      agentId: "agent_1",
      agentConfig: { workspaces: [{ name: "notes", workspaceId: "ws_a" }] },
      channelName: "slack",
      conversationKey: "slack:C1:T1",
      eventId: "evt_1",
    },
  );
}

function textOf(event: ConversationIngressEvent | undefined): string[] {
  const content = event?.content;
  if (!Array.isArray(content)) return [];

  return content.map((part): string =>
    part.type === "text" ? part.text : part.type,
  );
}

describe("appendToLatestUserEvent", (): void => {
  test("puts the note after the text of a string-content user event", async (): Promise<void> => {
    const result = await ingest([{ role: "user", content: "see this" }]);
    const parts = textOf(result.events[0]);

    expect(result.events).toHaveLength(1);
    expect(parts[0]).toBe("see this");
    expect(parts[1]).toContain(REFUSED_NOTE);
  });

  test("drops an empty text part and keeps the rest", async (): Promise<void> => {
    const result = await ingest([
      { role: "user", content: [{ type: "text", text: "" }] },
    ]);
    const parts = textOf(result.turnEvents[0]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain(REFUSED_NOTE);
  });

  test("skips trailing non-user events and edits the last user one", async (): Promise<void> => {
    const result = await ingest([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "assistant", content: "reply" },
    ]);

    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toEqual({ role: "user", content: "first" });
    expect(textOf(result.events[1])[0]).toBe("second");
    expect(textOf(result.events[1])).toHaveLength(2);
    expect(result.events[2]).toEqual({ role: "assistant", content: "reply" });
  });

  test("adds a user event when none exists", async (): Promise<void> => {
    const result = await ingest([{ role: "assistant", content: "hi" }]);

    expect(result.events).toHaveLength(2);
    expect(result.events[1]?.role).toBe("user");
  });
});
