import { afterEach, expect, spyOn, test } from "bun:test";
import {
  logInfo,
  setLogService,
} from "../../../../apps/discord-forwarder/src/log.ts";

afterEach((): void => {
  setLogService("discord-forwarder");
  spyOn(console, "log").mockRestore();
});

function loggedService(): string {
  const spy = spyOn(console, "log").mockImplementation((): void => {});
  logInfo("hello");
  const line = String(spy.mock.calls.at(-1)?.[0]);
  spy.mockRestore();

  return (JSON.parse(line) as { service: string }).service;
}

test("setLogService renames the service later lines carry", (): void => {
  expect(loggedService()).toBe("discord-forwarder");

  setLogService("forwarder-a");
  expect(loggedService()).toBe("forwarder-a");

  setLogService("forwarder-b");
  expect(loggedService()).toBe("forwarder-b");
});
