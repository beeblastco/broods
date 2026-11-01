import { describe, expect, test } from "bun:test";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import type { OptimisticLocalStore } from "convex/browser";
import { getFunctionName } from "convex/server";
import { applyProjectRename } from "../app/lib/projectOptimistic";

const ALPHA = "p_alpha" as Id<"projects">;
const BETA = "p_beta" as Id<"projects">;

function project(id: Id<"projects">, name: string): Doc<"projects"> {
  return {
    _creationTime: 0,
    _id: id,
    description: `${name} description`,
    name: name,
    slug: name,
  } as Doc<"projects">;
}

/** A store holding a project list and one project, recording every write by function name. */
function localStore(
  list: Doc<"projects">[] | undefined,
  byId: Doc<"projects"> | null | undefined,
): { store: OptimisticLocalStore; written: Map<string, unknown> } {
  const written = new Map<string, unknown>();
  const store = {
    getQuery: (fn: Parameters<typeof getFunctionName>[0]) =>
      getFunctionName(fn) === getFunctionName(api.project.list) ? list : byId,
    setQuery: (
      fn: Parameters<typeof getFunctionName>[0],
      _args: unknown,
      value: unknown,
    ) => {
      written.set(getFunctionName(fn), value);
    },
  } as unknown as OptimisticLocalStore;

  return { store: store, written: written };
}

describe("applyProjectRename", () => {
  test("renames the project in the list and on its own, nothing else", () => {
    const { store, written } = localStore(
      [project(ALPHA, "alpha"), project(BETA, "beta")],
      project(ALPHA, "alpha"),
    );

    applyProjectRename(store, { name: "Alpha prime", projectId: ALPHA });

    expect(written.get(getFunctionName(api.project.list))).toEqual([
      { ...project(ALPHA, "alpha"), name: "Alpha prime" },
      project(BETA, "beta"),
    ]);
    expect(written.get(getFunctionName(api.project.getById))).toEqual({
      ...project(ALPHA, "alpha"),
      name: "Alpha prime",
    });
  });

  test("leaves queries that are not loaded, or do not hold the project, alone", () => {
    const { store, written } = localStore([project(BETA, "beta")], undefined);

    applyProjectRename(store, { name: "Alpha prime", projectId: ALPHA });

    expect(written.size).toBe(0);
  });
});
