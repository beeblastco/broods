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

function localStore(
  list: Doc<"projects">[] | undefined,
  byId: Doc<"projects"> | null | undefined,
): {
  store: OptimisticLocalStore;
  written: Map<string, unknown>;
  writtenArgs: Map<string, unknown>;
} {
  const written = new Map<string, unknown>();
  const writtenArgs = new Map<string, unknown>();
  const store = {
    getQuery: (fn: Parameters<typeof getFunctionName>[0]) =>
      getFunctionName(fn) === getFunctionName(api.dashboardReads.projects)
        ? list
        : byId,
    setQuery: (
      fn: Parameters<typeof getFunctionName>[0],
      args: unknown,
      value: unknown,
    ) => {
      written.set(getFunctionName(fn), value);
      writtenArgs.set(getFunctionName(fn), args);
    },
  } as unknown as OptimisticLocalStore;

  return { store: store, written: written, writtenArgs: writtenArgs };
}

describe("applyProjectRename", () => {
  test("renames the project in the list and on its own, nothing else", () => {
    const { store, written, writtenArgs } = localStore(
      [project(ALPHA, "alpha"), project(BETA, "beta")],
      project(ALPHA, "alpha"),
    );

    applyProjectRename(store, { name: "Alpha prime", projectId: ALPHA });

    expect(written.get(getFunctionName(api.dashboardReads.projects))).toEqual([
      { ...project(ALPHA, "alpha"), name: "Alpha prime" },
      project(BETA, "beta"),
    ]);
    expect(
      written.get(getFunctionName(api.dashboardReads.projectById)),
    ).toEqual({
      ...project(ALPHA, "alpha"),
      name: "Alpha prime",
    });
    expect(
      writtenArgs.get(getFunctionName(api.dashboardReads.projectById)),
    ).toEqual({
      projectId: ALPHA,
    });
  });

  test("leaves queries that are not loaded, or do not hold the project, alone", () => {
    const { store, written } = localStore([project(BETA, "beta")], undefined);

    applyProjectRename(store, { name: "Alpha prime", projectId: ALPHA });

    expect(written.size).toBe(0);
  });
});
