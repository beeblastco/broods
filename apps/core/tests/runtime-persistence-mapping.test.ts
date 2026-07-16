/** Verifies runtime-persistence mappings against the registered Convex exports. */

import { describe, expect, it } from "bun:test";
import { getFunctionName } from "convex/server";
import {
  runtimeMutations,
  runtimeQueries,
} from "../src/shared/convex/runtime.ts";

type RegisteredFunction = {
  isInternal?: boolean;
  isMutation?: boolean;
  isQuery?: boolean;
};

const registeredModules = {
  runtime: require("@broods/convex/runtime"),
  runtimeIngress: require("@broods/convex/runtimeIngress"),
} as Record<string, Record<string, RegisteredFunction | undefined>>;

function registered(
  ref: Parameters<typeof getFunctionName>[0],
): RegisteredFunction | undefined {
  const [moduleName, functionName] = getFunctionName(ref).split(":");
  return moduleName && functionName
    ? registeredModules[moduleName]?.[functionName]
    : undefined;
}

describe("runtime persistence function mapping", () => {
  it("addresses every query at the runtime module", () => {
    for (const ref of Object.values(runtimeQueries)) {
      expect(registered(ref)).toMatchObject({
        isInternal: true,
        isQuery: true,
      });
    }
  });

  it("addresses every mutation at the runtime module", () => {
    for (const ref of Object.values(runtimeMutations)) {
      expect(registered(ref)).toMatchObject({
        isInternal: true,
        isMutation: true,
      });
    }
  });
});
