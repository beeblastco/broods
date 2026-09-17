import { describe, expect, test } from "bun:test";
import {
  enabledMemberStatus,
  sandboxMemberStatus,
  summarizeMembers,
  workspaceMemberStatus,
} from "../app/lib/memberStatus";

describe("summarizeMembers", () => {
  test("grey when every member is idle, disabled or not connected", () => {
    expect(
      summarizeMembers([
        enabledMemberStatus(false),
        sandboxMemberStatus({ label: "cloud", status: "idle" }, undefined),
        sandboxMemberStatus({ label: "mac" }, "offline"),
        workspaceMemberStatus({ kind: "inherited", sandboxLabels: ["cloud"] }),
      ]),
    ).toEqual({
      color: "bg-muted-foreground",
      text: "1 disabled · 1 idle · 1 offline · 1 inherited",
    });
  });

  test("takes the color of the member that matters most: error, warn, ok, idle", () => {
    const connected = sandboxMemberStatus({ label: "mac" }, "connected");
    const offline = sandboxMemberStatus({ label: "old" }, "offline");
    const readOnly = workspaceMemberStatus({ kind: "readonly" });
    const failed = sandboxMemberStatus(
      { label: "cloud", status: "error" },
      undefined,
    );

    expect(summarizeMembers([offline, connected]).color).toBe("bg-success");
    expect(summarizeMembers([connected, readOnly]).color).toBe("bg-warning");
    expect(summarizeMembers([readOnly, failed, connected]).color).toBe(
      "bg-destructive",
    );
  });

  test("a mounted workspace reads as active in its own color", () => {
    const mounted = workspaceMemberStatus({
      kind: "override",
      sandboxLabels: ["cloud"],
    });

    expect(
      summarizeMembers([
        workspaceMemberStatus({ kind: "inherited", sandboxLabels: ["cloud"] }),
        mounted,
      ]),
    ).toEqual({ color: "bg-canvas-mount", text: "1 inherited · 1 mounted" });
  });

  test("an enabled server or skill is ok, a disabled one grey and idle", () => {
    expect(enabledMemberStatus(true)).toMatchObject({
      color: "bg-success",
      level: "ok",
    });
    expect(enabledMemberStatus(false)).toMatchObject({
      color: "bg-muted-foreground",
      level: "idle",
    });
  });
});
