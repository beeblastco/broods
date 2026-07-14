/** Verifies runtime-persistence mappings against the registered Convex exports. */

import { describe, expect, it } from "bun:test";
import { getFunctionName } from "convex/server";
import { runtimeMutations, runtimeQueries } from "../src/shared/convex/runtime.ts";

const MODULE = "runtime";
type RegisteredFunction = {
  isInternal?: boolean;
  isMutation?: boolean;
  isQuery?: boolean;
};

const registeredFunctions = require("@broods/convex/runtime") as Record<
  string,
  RegisteredFunction | undefined
>;

describe("runtime persistence function mapping", () => {
  it("addresses every query at the runtime module", () => {
    for (const [name, ref] of Object.entries(runtimeQueries)) {
      expect(registeredFunctions[name]).toMatchObject({ isInternal: true, isQuery: true });
      expect(getFunctionName(ref)).toBe(`${MODULE}:${name}`);
    }
  });

  it("addresses every mutation at the runtime module", () => {
    for (const [name, ref] of Object.entries(runtimeMutations)) {
      expect(registeredFunctions[name]).toMatchObject({ isInternal: true, isMutation: true });
      expect(getFunctionName(ref)).toBe(`${MODULE}:${name}`);
    }
  });
});
