/**
 * Keeps the live tests' in-memory reservation table in step with
 * `instance-store.ts`: the live suites only run with credentials, so this is
 * what catches the table drifting from the calls the executors make.
 */

import { describe, expect, it } from "bun:test";
import {
  claimSandboxInstance,
  deleteSandboxInstance,
  getSandboxExternalId,
  getSandboxReleaseTarget,
  getSandboxReservationRecord,
} from "../src/harness/sandbox/instance-store.ts";
import { useLiveReservations } from "./helpers/live-reservations.ts";

const table = useLiveReservations();

describe("live reservation table", () => {
  it("answers every reservation call the executors make", async () => {
    expect(await claimSandboxInstance("lambda", "key", "vm-1", "acct")).toBe(
      true,
    );
    expect(await claimSandboxInstance("lambda", "key", "vm-2", "acct")).toBe(
      false,
    );
    expect(await getSandboxExternalId("lambda", "key")).toBe("vm-1");
    expect(
      (await getSandboxReservationRecord("lambda", "key"))?.externalId,
    ).toBe("vm-1");
    expect(await getSandboxReleaseTarget("acct", "lambda", "key")).toEqual({
      externalId: "vm-1",
      instance: null,
    });
    expect(await deleteSandboxInstance("lambda", "key", "acct", "vm-2")).toBe(
      false,
    );
    expect(await deleteSandboxInstance("lambda", "key", "acct", "vm-1")).toBe(
      true,
    );
    expect(table.size).toBe(0);
  });
});
