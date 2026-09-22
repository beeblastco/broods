import { describe, expect, test } from "bun:test";
import { rankItems, type SearchItem } from "../app/lib/paletteSearch";

function node(title: string): SearchItem {
  return {
    group: "Nodes",
    id: `node:${title}`,
    target: { nodeId: title, type: "openNode" },
    title: title,
  };
}

describe("palette ranking", () => {
  test("an exact name beats a longer name that merely starts with the query", () => {
    const ranked = rankItems([node("api-gateway-worker"), node("api")], "api");

    expect(ranked[0].items.map((item) => item.title)).toEqual([
      "api",
      "api-gateway-worker",
    ]);
  });

  test("a word inside a hyphenated name matches, an unrelated name does not", () => {
    const ranked = rankItems(
      [node("nightly-digest"), node("triage")],
      "digest",
    );

    expect(
      ranked.flatMap((group) => group.items).map((item) => item.title),
    ).toEqual(["nightly-digest"]);
  });

  test("keywords match but rank below anything the title matched", () => {
    const page: SearchItem = {
      group: "Go to",
      id: "page:/dashboard",
      keywords: ["traces"],
      target: { href: "/p/dashboard", type: "navigate" },
      title: "Dashboard",
    };
    const ranked = rankItems([page, node("traces-collector")], "traces");

    // The node's title match outranks the page's keyword match, and groups keep
    // their own heading order regardless.
    expect(ranked.map((group) => group.group)).toEqual(["Go to", "Nodes"]);
    expect(ranked[1].items[0].title).toBe("traces-collector");
  });

  test("an empty query keeps every row in its original order", () => {
    const ranked = rankItems([node("b"), node("a")], "   ");

    expect(ranked[0].items.map((item) => item.title)).toEqual(["b", "a"]);
  });

  test("one group cannot crowd out the others", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      node(`agent-${index}`),
    );
    const ranked = rankItems(many, "agent");

    expect(ranked[0].items).toHaveLength(5);
  });
});
