import { describe, expect, test } from "bun:test";
import {
  machineStartCommand,
  machineState,
  type MachineConnection,
} from "../app/lib/machineConnection";

const NOW = 1_000_000_000;

describe("machineState", () => {
  test("reads a row as connected until two heartbeats go missing", () => {
    expect(machineState(connection({ lastSeenAt: NOW - 149_000 }), NOW)).toBe(
      "connected",
    );
    expect(machineState(connection({ lastSeenAt: NOW - 150_000 }), NOW)).toBe(
      "offline",
    );
  });

  test("reads a stamped disconnect as offline even right after a heartbeat", () => {
    expect(machineState(connection({ disconnectedAt: NOW }), NOW)).toBe(
      "offline",
    );
  });

  test("reads a sandbox with no row as never connected", () => {
    expect(machineState(null, NOW)).toBe("never");
  });
});

describe("machineStartCommand", () => {
  test("repeats the flags the daemon last started with", () => {
    expect(
      machineStartCommand(
        "my-mac",
        connection({ computer: true, mcp: ["echo"] }),
      ),
    ).toBe("broods machine my-mac --computer --mcp <file>");
    expect(machineStartCommand("my-mac", null)).toBe("broods machine my-mac");
  });
});

function connection(overrides: Partial<MachineConnection>): MachineConnection {
  return {
    _creationTime: NOW,
    _id: "conn_1" as MachineConnection["_id"],
    accountId: "acct_1" as MachineConnection["accountId"],
    computer: false,
    connectedAt: NOW,
    connectionId: "first",
    lastSeenAt: NOW,
    mcp: [],
    name: "my-mac",
    sandboxConfigId: "cfg_1" as MachineConnection["sandboxConfigId"],
    ...overrides,
  };
}
