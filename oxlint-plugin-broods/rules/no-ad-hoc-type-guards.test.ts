import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-ad-hoc-type-guards";
const rule = ruleTester(RULE);
const NAMED = "find the value's real type";
const PREDICATE = "Drop this `unknown` to `Record<string, …>` guard";

describe(RULE, () => {
  rule.valid(
    "allows guards that narrow a known type, and unrelated names",
    `
      type Json = string | number | Json[] | { [key: string]: Json };
      export function isJsonMap(value: Json): value is { [key: string]: Json } {
        return typeof value === "object" && !Array.isArray(value);
      }
      export const isAgentFrame = (value: unknown): value is { type: "agent" } =>
        typeof value === "object" && value !== null;
      export const isRecordingActive = () => true;
      export const helpers = { isObjectId: (id: string): boolean => id.length === 24 };
    `,
  );

  rule.invalid(
    "reports every spelling of a banned guard name",
    `
      export function isPlainObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null;
      }
      const isRecord = (value: unknown) => typeof value === "object";
      export const guards = {
        isObject(value: unknown) { return typeof value === "object"; },
        isStringRecord: function (value: unknown) { return value !== null; },
      };
      export class Checks {
        isJsonObject(value: unknown) { return value !== null; }
        isUnknownRecord = (value: unknown) => value !== null;
      }
      export const used = isRecord;
    `,
    [
      { line: 1, message: "Drop `isPlainObject`" },
      { line: 4, message: "Drop `isRecord`" },
      { line: 6, message: "Drop `isObject`" },
      { line: 7, message: "Drop `isStringRecord`" },
      { line: 10, message: "Drop `isJsonObject`" },
      { line: 11, message: "Drop `isUnknownRecord`" },
    ],
  );

  rule.invalid(
    "reports an unknown to record predicate whatever its name",
    `
      export function isHeaderMap(value: unknown): value is Record<string, string> {
        return typeof value === "object";
      }
      export const isBag = (input: any): input is { [key: string]: unknown } => !!input;
      export function assertMap(value: unknown): asserts value is Record<string, number> {}
    `,
    [
      { line: 1, message: PREDICATE },
      { line: 4, message: PREDICATE },
      { line: 5, message: PREDICATE },
    ],
  );

  rule.valid(
    "matches names case-sensitively",
    `
      export const isrecord = (value: unknown) => value !== null;
      export const IsObject = (value: unknown) => value !== null;
    `,
  );
});

ruleTester(RULE, { ruleOptions: [{ names: ["isBag"] }] }).invalid(
  "takes its names from the option",
  `
    export const isRecord = (value: unknown) => value !== null;
    export const isBag = (value: unknown) => value !== null;
  `,
  [{ line: 2, message: NAMED }],
);

const allowed = ruleTester(RULE, {
  filename: "/repo/packages/convex/model/objects.ts",
  ruleOptions: [
    {
      allow: [
        { file: "packages/convex/model/objects.ts", name: "isPlainObject" },
      ],
    },
  ],
});

allowed.valid(
  "allows the approved guard in its own file",
  `
    export function isPlainObject(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
  `,
);

allowed.invalid(
  "allows only the named guard, not its neighbours",
  `
    export function isStringRecord(value: unknown): value is Record<string, string> {
      return typeof value === "object";
    }
  `,
  [{ line: 1, message: "Drop `isStringRecord`" }],
);

ruleTester(RULE, {
  filename: "apps/core/src/shared/object.ts",
  ruleOptions: [
    {
      allow: [
        { file: "packages/convex/model/objects.ts", name: "isPlainObject" },
      ],
    },
  ],
}).invalid(
  "does not carry the allowance to another file",
  `
    export function isPlainObject(value: unknown): value is Record<string, unknown> {
      return typeof value === "object";
    }
  `,
  [{ line: 1, message: "Drop `isPlainObject`" }],
);
