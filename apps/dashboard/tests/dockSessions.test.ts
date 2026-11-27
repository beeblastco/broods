import { describe, expect, test } from "bun:test";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  closeDockSession,
  openDockSession,
  openDockShell,
  pruneDock,
} from "../app/(main)/[projectId]/sandbox/components/dockSessions";

const CFBOX = "cfbox" as Id<"sandboxInstances">;
const WEB = "web" as Id<"sandboxInstances">;

describe("dock sessions", () => {
  test("a fresh shell numbers on and stays next to its sandbox's sessions", () => {
    let state = openDockSession(null, CFBOX, "shell");
    state = openDockSession(state, WEB, "shell");
    state = openDockShell(state, CFBOX);

    expect(
      state.sessions.map((session) => `${session.instanceId}:${session.shell}`),
    ).toEqual(["cfbox:1", "cfbox:2", "web:1"]);
    expect(state.active).toBe("cfbox:shell:2");
  });

  test("opening shows the sandbox's existing session", () => {
    let state = openDockSession(null, CFBOX, "shell");
    state = openDockShell(state, CFBOX);
    state = openDockSession(state, CFBOX, "shell");

    expect(state.sessions).toHaveLength(2);
    expect(state.active).toBe("cfbox:shell:1");
  });

  test("a sandbox has one log tail", () => {
    let state = openDockSession(null, WEB, "logs");
    state = openDockSession(state, WEB, "logs");

    expect(state.sessions).toHaveLength(1);
  });

  test("closing the shown session shows its neighbour, and the last one closes the dock", () => {
    let state = openDockSession(null, CFBOX, "shell");
    state = openDockShell(state, CFBOX);
    const closed = closeDockSession(state, "cfbox:shell:2");

    expect(closed?.active).toBe("cfbox:shell:1");
    expect(closeDockSession(closed!, "cfbox:shell:1")).toBeNull();
  });

  test("a terminated sandbox's sessions leave the dock", () => {
    let state = openDockSession(null, CFBOX, "shell");
    state = openDockSession(state, WEB, "shell");

    expect(pruneDock(state, [{ _id: CFBOX }])?.sessions).toHaveLength(1);
    expect(pruneDock(state, [{ _id: CFBOX }])?.active).toBe("cfbox:shell:1");
    expect(pruneDock(state, [])).toBeNull();
  });
});
