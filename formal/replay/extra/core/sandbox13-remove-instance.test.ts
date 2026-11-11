import { afterEach, describe, expect, mock, test } from "bun:test";

process.env.CONVEX_URL = "https://convex.test";
process.env.CONVEX_DEPLOY_KEY = "prod:test|key";

const CLIENT_PATH = import.meta
  .resolve("../../../../apps/core/src/shared/convex/client.ts");
const realClient = await import(CLIENT_PATH);
const adminMutation = mock(async (): Promise<unknown> => true);
const internalPaths = new Proxy(
  {},
  {
    get: (_target: object, first: string): object =>
      new Proxy(
        {},
        {
          get: (_inner: object, second: string): object =>
            new Proxy(
              {},
              {
                get: (_leaf: object, third: string): string =>
                  `${first}.${second}.${third}`,
              },
            ),
        },
      ),
  },
);
await mock.module(CLIENT_PATH, () => ({
  ...realClient,
  adminMutation: adminMutation,
  internal: internalPaths,
}));

// Lazy so the module mock above is in place first.
const instances =
  await import("../../../../apps/core/src/shared/convex/sandbox-instances.ts");

afterEach((): void => {
  adminMutation.mockReset();
});

describe("removeSandboxInstance retries", () => {
  test("a lost remove is sent again and stops at the first success", async (): Promise<void> => {
    adminMutation
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(true);
    await instances.removeSandboxInstance("acct_1", "key_1", "ext_1");
    expect(adminMutation).toHaveBeenCalledTimes(2);
    expect(adminMutation).toHaveBeenLastCalledWith(
      "sandbox.instances.remove",
      { accountId: "acct_1", reservationKey: "key_1", externalId: "ext_1" },
      { skipQueue: true },
    );
  });

  test("three failures are logged, not thrown", async (): Promise<void> => {
    adminMutation.mockRejectedValue(new Error("down"));
    await instances.removeSandboxInstance("acct_1", "key_2");
    expect(adminMutation).toHaveBeenCalledTimes(3);
  });
});
