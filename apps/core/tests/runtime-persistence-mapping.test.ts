/** Pins the runtime-persistence mapping to the Convex module that exports it. */

import { describe, expect, it } from "bun:test";
import { getFunctionName } from "convex/server";
import { runtimeMutations, runtimeQueries } from "../src/shared/convex/runtime.ts";

// `internal` in runtime.ts is an anyApi proxy: it fabricates a function path
// from whatever properties are accessed, so pointing the mapping at a module
// that doesn't exist compiles and unit-tests cleanly, then fails in production
// with "Could not find public function". This test hard-codes the module that
// actually hosts the runtime persistence functions (packages/convex/
// runtimePersistence.ts) so a rename on either side fails here first.
const MODULE = "runtimePersistence";

describe("runtime persistence function mapping", () => {
  it("addresses every query at the runtimePersistence module", () => {
    for (const [name, ref] of Object.entries(runtimeQueries)) {
      expect(getFunctionName(ref)).toBe(`${MODULE}:${name}`);
    }
  });

  it("addresses every mutation at the runtimePersistence module", () => {
    for (const [name, ref] of Object.entries(runtimeMutations)) {
      expect(getFunctionName(ref)).toBe(`${MODULE}:${name}`);
    }
  });
});
