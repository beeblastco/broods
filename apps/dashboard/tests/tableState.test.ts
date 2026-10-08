import { describe, expect, test } from "bun:test";
import {
  clearField,
  sortRows,
  toggleToken,
  tokenValues,
} from "../app/lib/tableState";

describe("toggleToken", () => {
  test("adds a chip with a trailing space so the next word is free text", () => {
    expect(toggleToken("", "agent", "billing")).toBe("agent:billing ");
    expect(toggleToken("timeout", "agent", "billing")).toBe(
      "timeout agent:billing ",
    );
  });

  test("removes the chip when it is already there, case apart", () => {
    expect(toggleToken("Agent:Billing timeout", "agent", "billing")).toBe(
      "timeout",
    );
  });
});

describe("clearField and tokenValues", () => {
  test("drops every token of the field and keeps the rest", () => {
    const query = "agent:billing status:ok agent:ops text";
    expect(clearField(query, "agent")).toBe("status:ok text");
    expect(tokenValues(query, "agent")).toEqual(["billing", "ops"]);
    expect(tokenValues("agent:", "agent")).toEqual([]);
  });
});

describe("sortRows", () => {
  const rows = [
    { name: "ops", at: 3 },
    { name: "Billing", at: null },
    { name: "agent-10", at: 1 },
    { name: "agent-9", at: 2 },
  ];

  test("sorts strings without case and with numbers in order", () => {
    expect(sortRows(rows, (row) => row.name, "asc").map((r) => r.name)).toEqual(
      ["agent-9", "agent-10", "Billing", "ops"],
    );
  });

  test("puts a null key last in both directions and keeps ties stable", () => {
    expect(sortRows(rows, (row) => row.at, "asc").map((r) => r.name)).toEqual([
      "agent-10",
      "agent-9",
      "ops",
      "Billing",
    ]);
    expect(sortRows(rows, (row) => row.at, "desc").map((r) => r.name)).toEqual([
      "ops",
      "agent-9",
      "agent-10",
      "Billing",
    ]);
  });
});
