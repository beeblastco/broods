import { describe, expect, test } from "bun:test";
import {
  mcpMemberStatus,
  sandboxMemberStatus,
  summarizeMembers,
  workspaceMemberStatus,
} from "../app/lib/memberStatus";

describe("summarizeMembers", () => {
  test("grey when every member is idle, disabled or not connected", () => {
    expect(
      summarizeMembers([
        mcpMemberStatus(undefined),
        sandboxMemberStatus({ label: "cloud", status: "idle" }, undefined),
        sandboxMemberStatus({ label: "mac" }, "offline"),
        workspaceMemberStatus({ kind: "inherited", sandboxLabel: "cloud" }),
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
        workspaceMemberStatus({ kind: "inherited", sandboxLabel: "cloud" }),
        mounted,
      ]),
    ).toEqual({ color: "bg-canvas-mount", text: "1 inherited · 1 mounted" });
  });

  test("an enabled server is ok, a disabled one idle", () => {
    const server = {
      disabled: false,
      name: "github",
      nodeId: "github",
      sandbox: null,
      transport: "http" as const,
    };

    expect(mcpMemberStatus(server).level).toBe("ok");
    expect(mcpMemberStatus({ ...server, disabled: true }).level).toBe("idle");
  });
});
