import { describe, expect, test } from "bun:test";

import {
  agentCanvasBadge,
  assertEnvVarName,
  substituteEnvPlaceholders,
} from "../../../../packages/convex/model/agentConfigCodec";
import { defaultSandboxOf } from "../../../../packages/convex/model/agentRules";
import {
  ClientError,
  clientErrorResponse,
} from "../../../../packages/convex/model/clientError";
import { findLaterSandboxMount } from "../../../../packages/convex/model/sandboxMounts";

type BadgeConfig = Parameters<typeof agentCanvasBadge>[0];
type BadgeExpected = { publicAccess: boolean; skills: string[] };

const badges: Array<[string, unknown, BadgeExpected]> = [
  ["no extra config", {}, { publicAccess: false, skills: [] }],
  [
    "public with skills",
    {
      extraConfig: {
        publicAccess: true,
        skills: { enabled: true, allowed: ["a", 1, "b"] },
      },
    },
    { publicAccess: true, skills: ["a", "b"] },
  ],
  [
    "skills disabled",
    { extraConfig: { skills: { enabled: false, allowed: ["a"] } } },
    { publicAccess: false, skills: [] },
  ],
  [
    "unstructured output",
    { outputFormat: { type: "text" } },
    { publicAccess: false, skills: [] },
  ],
  [
    "structured output",
    { outputFormat: { type: "json" } },
    { publicAccess: false, skills: [] },
  ],
  [
    "allowed not a list",
    {
      extraConfig: {
        publicAccess: "yes",
        skills: { enabled: true, allowed: "a" },
      },
    },
    { publicAccess: false, skills: [] },
  ],
];

const envNames: Array<[string, boolean]> = [
  ["GOOD_NAME_1", true],
  ["1BAD", false],
  ["lower", false],
  [`A${"B".repeat(64)}`, false],
];

const defaultSandboxes: Array<
  [string, Record<string, unknown>, string | undefined]
> = [
  ["first", { sandboxes: ["a", "b"] }, "a"],
  ["not a list", { sandboxes: "a" }, undefined],
  ["empty", { sandboxes: [] }, undefined],
  ["not a string", { sandboxes: [1] }, undefined],
  ["missing", {}, undefined],
];

// Inputs here also feed the Lean twins: each row is a branch of the real function.
describe("agent config helpers", (): void => {
  test.each(badges)(
    "badge: %s",
    (_name: string, config: unknown, expected: BadgeExpected): void => {
      expect(agentCanvasBadge(config as BadgeConfig)).toMatchObject(expected);
    },
  );

  test.each(envNames)("env name %s", (name: string, good: boolean): void => {
    if (good) expect(assertEnvVarName(name)).toBeUndefined();
    else
      expect((): void => assertEnvVarName(name)).toThrow("env name must match");
  });

  test("substitutes a known variable", (): void => {
    expect(substituteEnvPlaceholders({ a: "${A}" }, { A: "1" })).toEqual({
      a: "1",
    });
  });

  test.each(defaultSandboxes)(
    "default sandbox: %s",
    (
      _name: string,
      config: Record<string, unknown>,
      expected: string | undefined,
    ): void => {
      expect(defaultSandboxOf(config)).toBe(expected);
    },
  );

  test("finds no later mount without workspaces", (): void => {
    expect(findLaterSandboxMount(["a", "b"], undefined)).toBeUndefined();
    expect(findLaterSandboxMount([], null)).toBeUndefined();
  });

  test("finds a workspace mounted on a later sandbox", (): void => {
    const workspace = { name: "notes", workspaceId: "ws_a", sandbox: "b" };

    expect(findLaterSandboxMount(["a", "b"], [workspace])).toBeDefined();
  });

  test("maps a client error and ignores others", async (): Promise<void> => {
    const response = clientErrorResponse(new ClientError("gone", "not_found"));

    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({
      error: { message: "gone" },
    });
    expect(clientErrorResponse(new Error("plain"))).toBeNull();
  });
});
