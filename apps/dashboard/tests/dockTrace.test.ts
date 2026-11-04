import { describe, expect, test } from "bun:test";
import type { TextStreamPart, ToolSet } from "ai";
import { sameOriginPath } from "@/app/lib/navigation";
import {
  navigatePath,
  pageLabel,
  traceStep,
  type DockTracePart,
} from "../app/lib/dockTrace";

function fold(
  parts: readonly TextStreamPart<ToolSet>[],
): readonly DockTracePart[] {
  return parts.reduce<readonly DockTracePart[]>(
    (trace, part, index) => traceStep(trace, part, index * 100),
    [],
  );
}

describe("dock trace", () => {
  test("reasoning and tool steps keep stream order, each tool settling where it started", () => {
    const trace = fold([
      { id: "r1", type: "reasoning-start" },
      { id: "r1", text: "Look up ", type: "reasoning-delta" },
      { id: "r1", text: "the agents.", type: "reasoning-delta" },
      { id: "r1", type: "reasoning-end" },
      { id: "t1", toolName: "dock__broods_api", type: "tool-input-start" },
      {
        dynamic: true,
        input: { method: "get", path: "/v1/agents" },
        toolCallId: "t1",
        toolName: "dock__broods_api",
        type: "tool-call",
      },
      { text: "ignored", type: "text-delta", id: "x" },
      {
        dynamic: true,
        input: {},
        output: {
          content: [
            { text: "200", type: "text" },
            { text: '{"agents":2}', type: "text" },
          ],
        },
        toolCallId: "t1",
        toolName: "dock__broods_api",
        type: "tool-result",
      },
    ]);

    expect(trace).toEqual([
      { id: "r1", kind: "reasoning", text: "Look up the agents." },
      {
        endedAt: 700,
        id: "t1",
        input: { method: "get", path: "/v1/agents" },
        kind: "tool",
        name: "dock__broods_api",
        output: '200\n{"agents":2}',
        startedAt: 400,
        title: "GET /v1/agents",
      },
    ]);
  });

  test("an empty reasoning block is dropped and a tool error settles the step", () => {
    const trace = fold([
      { id: "r1", type: "reasoning-start" },
      { id: "r1", type: "reasoning-end" },
      {
        dynamic: true,
        error: new Error("fetch failed"),
        input: { url: "https://x.test" },
        toolCallId: "t2",
        toolName: "web_fetch",
        type: "tool-error",
      },
    ]);

    expect(trace).toMatchObject([
      { endedAt: 200, error: "fetch failed", kind: "tool", title: "web_fetch" },
    ]);
  });

  test("navigate reads as the page it opens, and refuses a path off the dashboard", () => {
    const [opened, refused] = fold([
      {
        dynamic: true,
        input: { path: "/p1/dashboard?stage=s1&tab=tracing" },
        toolCallId: "n1",
        toolName: "dock__navigate",
        type: "tool-call",
      },
      {
        dynamic: true,
        input: { path: "//evil.test" },
        toolCallId: "n2",
        toolName: "dock__navigate",
        type: "tool-call",
      },
    ]);

    expect(opened).toMatchObject({ title: "Opened Dashboard / Tracing" });
    expect(opened).not.toHaveProperty("error");
    expect(refused).toMatchObject({ error: "Not a dashboard path." });
  });

  test("only same-origin dashboard paths navigate", () => {
    expect(navigatePath({ path: "/p1/scheduler?stage=s1" })).toBe(
      "/p1/scheduler?stage=s1",
    );
    expect(navigatePath({ path: "/\\evil.test" })).toBeNull();
    expect(navigatePath({ path: "javascript:alert(1)" })).toBeNull();
    expect(navigatePath({ path: "https://evil.test/" })).toBeNull();
    expect(navigatePath({ path: 3 })).toBeNull();
  });

  test("a page reads as the sidebar names it", () => {
    expect(pageLabel("/p1")).toBe("Architecture");
    expect(pageLabel("/p1/scheduler?stage=s1")).toBe("Scheduler");
    expect(pageLabel("/settings/org?tab=members")).toBe(
      "Organization / Members",
    );
  });
});

describe("sameOriginPath", () => {
  const base = "https://app.broods.test/p1/canvas?stage=s1";

  test("keeps dashboard links on the page, resolved as a browser would", () => {
    expect(sameOriginPath("/p1/scheduler", base)).toBe("/p1/scheduler");
    expect(sameOriginPath("#runs", base)).toBe("/p1/canvas?stage=s1#runs");
    expect(sameOriginPath("tracing", base)).toBe("/p1/tracing");
  });

  test("refuses anything that leaves the origin", () => {
    for (const href of [
      "//evil.test",
      "/\\evil.test",
      "/\t/evil.test",
      "https://evil.test/p1",
      "javascript:alert(1)",
    ]) {
      expect(sameOriginPath(href, base), href).toBeNull();
    }
  });
});
