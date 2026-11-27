import { expect, spyOn, test } from "bun:test";
import { logInfo } from "../../../../apps/discord-forwarder/src/log.ts";

test("a log line carries the forwarder's service name", (): void => {
  const spy = spyOn(console, "log").mockImplementation((): void => {});
  logInfo("hello");
  const line = String(spy.mock.calls.at(-1)?.[0]);
  spy.mockRestore();

  expect(JSON.parse(line)).toMatchObject({
    service: "discord-forwarder",
    message: "hello",
  });
});
