/** Account cleanup retry-safety tests. */

import { afterEach, expect, it } from "bun:test";
import { deleteAccountRuntimeData } from "../src/accounts/cleanup.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../src/shared/storage.ts";

afterEach(() => {
  resetStorageForTests();
});

it("propagates workspace listing failures before destructive cleanup", async () => {
  setStorageForTests({
    workspaceConfigs: {
      async list() {
        throw new Error("workspace list unavailable");
      },
    },
  } as never);

  await expect(deleteAccountRuntimeData({
    accountId: "acct_test",
    username: "test",
    secretHash: "hash",
    status: "disabled",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  })).rejects.toThrow("workspace list unavailable");
});
