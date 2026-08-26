/** Every config-plane surface must be mounted, not just parsed. */

import { describe, expect, it } from "vitest";
import http from "../http";
import { handle as cliHttp } from "../cliHttp";
import { handle as cliProjectsHttp } from "../cliProjectsHttp";
import { handle as cliStagesHttp } from "../cliStagesHttp";

// A handler that configHttp knows how to dispatch is still a 404 until the
// router mounts it. That gap shipped once for /v1/channels and reached dev, so
// pin the collection and item verbs for every config-plane surface here.
const SURFACES: Array<{
  path: string;
  collection: Array<"GET" | "POST">;
  item: Array<"GET" | "PATCH" | "DELETE" | "POST" | "PUT">;
}> = [
  {
    path: "/v1/agents",
    collection: ["GET", "POST"],
    item: ["GET", "PATCH", "DELETE"],
  },
  {
    path: "/v1/channels",
    collection: ["GET", "POST"],
    item: ["GET", "PATCH", "DELETE"],
  },
  {
    path: "/v1/crons",
    collection: ["GET", "POST"],
    item: ["GET", "PATCH", "DELETE"],
  },
  {
    path: "/v1/hooks",
    collection: ["GET", "POST"],
    item: ["GET", "PATCH", "DELETE"],
  },
  {
    path: "/v1/policies",
    collection: ["GET", "POST"],
    item: ["GET", "PATCH", "DELETE"],
  },
  {
    path: "/v1/skills",
    collection: ["GET", "POST"],
    item: ["GET", "PUT", "DELETE"],
  },
  {
    path: "/v1/tools",
    collection: ["GET", "POST"],
    item: ["GET", "PATCH", "DELETE"],
  },
  {
    path: "/v1/workspaces",
    collection: ["GET", "POST"],
    item: ["GET", "PATCH", "DELETE"],
  },
];

describe("config-plane HTTP routes", () => {
  for (const surface of SURFACES) {
    it(`mounts ${surface.path}`, () => {
      for (const method of surface.collection) {
        expect(
          http.lookup(surface.path, method),
          `${method} ${surface.path}`,
        ).toBeTruthy();
      }
      for (const method of surface.item) {
        const path = `${surface.path}/id_1`;
        expect(http.lookup(path, method), `${method} ${path}`).toBeTruthy();
      }
    });
  }

  it("mounts workspace file and download-link surfaces", () => {
    expect(http.lookup("/v1/workspaces/ws_1/files", "GET")).toBeTruthy();
    expect(http.lookup("/v1/workspaces/ws_1/files", "POST")).toBeTruthy();
    expect(
      http.lookup("/v1/workspaces/ws_1/download-links", "POST"),
    ).toBeTruthy();
  });

  // `/v1/account/projects/` is mounted as a pathPrefix, so a stage route nested
  // under it would reach cliHttp and 404. Pin the sibling path instead.
  // Truthiness alone would still pass if a pathPrefix swallowed the path, so
  // assert which handler actually wins.
  it("mounts the CLI stage surface on its own handler", () => {
    for (const method of ["GET", "POST"] as const) {
      const route = http.lookup("/v1/account/stages", method);
      expect(route, `${method} /v1/account/stages`).toBeTruthy();
      expect(route?.[0], `${method} /v1/account/stages`).toBe(cliStagesHttp);
    }
  });

  // The bare path sits directly above the `/v1/account/projects/` pathPrefix
  // that cliHttp owns, so assert which handler wins rather than truthiness.
  it("mounts the CLI project surface on its own handler", () => {
    for (const method of ["GET", "DELETE"] as const) {
      const route = http.lookup("/v1/account/projects", method);
      expect(route, `${method} /v1/account/projects`).toBeTruthy();
      expect(route?.[0], `${method} /v1/account/projects`).toBe(
        cliProjectsHttp,
      );
    }
  });

  // The stage-scoped CLI routes stay on cliHttp, and the old `/environments/`
  // spelling must not resolve at all after the hard rename.
  it("routes project-scoped stage paths to cliHttp and drops /environments/", () => {
    expect(
      http.lookup("/v1/account/projects/p1/stages/s1/manifest", "GET")?.[0],
    ).toBe(cliHttp);
    expect(
      http.lookup(
        "/v1/account/projects/p1/environments/e1/manifest",
        "GET",
      )?.[0],
    ).not.toBe(cliStagesHttp);
  });

  // Redeeming happens in a browser with no credential, so it must resolve on a
  // bare GET. Convex serves HEAD from the same route.
  it("mounts download redemption for unauthenticated GET", () => {
    expect(http.lookup("/v1/downloads/abcdefghijklmnop", "GET")).toBeTruthy();
  });
});
