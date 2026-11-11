import { afterEach, describe, expect, test } from "bun:test";

import {
  isolatedWorkspaceNamespace,
  resolveAgentRuntime,
  workspaceNamespace,
} from "../../../../apps/core/src/shared/workspaces.ts";
import { setStorageForTests } from "../../../../apps/core/src/shared/storage.ts";

type Sandboxes = Record<string, Record<string, unknown>>;

afterEach((): void => {
  setStorageForTests(null);
});

function storeWith(sandboxes: Sandboxes, workspaces: Sandboxes): void {
  setStorageForTests({
    sandboxConfigs: {
      getById: async (
        _accountId: string,
        id: string,
      ): Promise<{
        sandboxId: string;
        name: string;
        config: Record<string, unknown>;
      } | null> =>
        sandboxes[id]
          ? { sandboxId: id, name: id, config: sandboxes[id] }
          : null,
    },
    workspaceConfigs: {
      getById: async (
        _accountId: string,
        id: string,
      ): Promise<{ config: Record<string, unknown> } | null> =>
        workspaces[id] ? { config: workspaces[id] } : null,
    },
  } as never);
}

describe("sharedWorkspaceNamespace", (): void => {
  test("a conversation partition needs a conversation key", (): void => {
    expect((): string =>
      isolatedWorkspaceNamespace(
        workspaceNamespace("acct_1", "ws_a"),
        "conversation",
        {
          channelName: "slack",
          partition: { alias: "chats", by: "conversation" },
        },
      ),
    ).toThrow(
      "Conversation workspace isolation requires an active conversation key",
    );
  });
});

describe("resolveAgentRuntime references", (): void => {
  test("a sandbox reference needs an account", async (): Promise<void> => {
    storeWith({ sb_1: { provider: "lambda" } }, {});

    await expect(
      resolveAgentRuntime({ sandboxes: ["sb_1"] }, {}),
    ).rejects.toThrow("Cannot resolve sandbox reference without an account");
  });

  test("a workspace reference needs an account", async (): Promise<void> => {
    storeWith({}, { ws_a: { storage: { provider: "s3" } } });

    await expect(
      resolveAgentRuntime(
        { workspaces: [{ name: "notes", workspaceId: "ws_a" }] },
        {},
      ),
    ).rejects.toThrow("Cannot resolve workspace reference without an account");
  });

  test("a missing workspace record is named", async (): Promise<void> => {
    storeWith({}, {});

    await expect(
      resolveAgentRuntime(
        { workspaces: [{ name: "notes", workspaceId: "ws_gone" }] },
        { accountId: "acct_1" },
      ),
    ).rejects.toThrow('Referenced workspace not found: ws_gone (as "notes")');
  });
});

describe("assertSandboxReachesWorkspace", (): void => {
  const disk = { ws_disk: { storage: { provider: "disk" } } };
  const refs = [{ name: "scratch", workspaceId: "ws_disk", sandbox: "sb_1" }];

  test("a disk workspace runs on a persistent worker sandbox", async (): Promise<void> => {
    storeWith({ sb_1: { provider: "worker", persistent: true } }, disk);

    const resolved = await resolveAgentRuntime(
      { workspaces: refs },
      { accountId: "acct_1" },
    );

    expect(resolved.workspaces[0]?.sandbox).toEqual(
      expect.objectContaining({ provider: "worker", persistent: true }),
    );
    expect(resolved.workspaces[0]?.sandbox).not.toHaveProperty("storage");
  });

  test("a disk workspace on another sandbox is refused with the hint", async (): Promise<void> => {
    storeWith({ sb_1: { provider: "lambda" } }, disk);

    await expect(
      resolveAgentRuntime({ workspaces: refs }, { accountId: "acct_1" }),
    ).rejects.toThrow('Workspace "scratch": a "disk" workspace lives on');
  });

  test("a disk workspace with no sandbox is refused", async (): Promise<void> => {
    storeWith({}, disk);

    await expect(
      resolveAgentRuntime(
        {
          workspaces: [
            { name: "scratch", workspaceId: "ws_disk", sandbox: null },
          ],
        },
        { accountId: "acct_1" },
      ),
    ).rejects.toThrow("give it a worker sandbox with persistent: true");
  });
});
