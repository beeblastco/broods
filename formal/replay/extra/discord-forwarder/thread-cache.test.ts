import { afterEach, expect, spyOn, test } from "bun:test";
import { ThreadDirectory } from "../../../../apps/discord-forwarder/src/threads.ts";

afterEach((): void => {
  spyOn(globalThis, "fetch").mockRestore();
});

test("a resolved thread answers later calls from the cache", async (): Promise<void> => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    async (): Promise<Response> =>
      Response.json({
        id: "thread-cached",
        parent_id: "parent-cached",
        type: 11,
      }),
  );
  const directory = new ThreadDirectory("token-cached");

  const first = await directory.resolve("thread-cached");
  const second = await directory.resolve("thread-cached");

  expect(first).toEqual({ id: "thread-cached", parent_id: "parent-cached" });
  expect(second).toEqual(first);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
