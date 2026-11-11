import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  getStorage,
  resetStorageForTests,
} from "../../../../apps/core/src/shared/storage.ts";

const { loadReentryTarget } =
  await import("../../../../apps/core/src/harness/handler.ts");

afterEach((): void => {
  resetStorageForTests();
});

describe("getStorage", (): void => {
  test("builds the Convex storage once and hands the same one back", (): void => {
    resetStorageForTests();

    const first = getStorage();

    expect(typeof first.agents.getById).toBe("function");
    expect(getStorage()).toBe(first);
  });
});

describe("loadReentryTarget", (): void => {
  test("an agent that no longer exists has no target", async (): Promise<void> => {
    spyOn(getStorage().agents, "getById").mockResolvedValue(null);

    expect(
      await loadReentryTarget(
        "acct_1",
        "agent_gone",
        "acct:acct_1:agent:agent_gone:api:chat",
      ),
    ).toBeNull();
  });
});
