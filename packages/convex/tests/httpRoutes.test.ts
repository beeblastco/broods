/** Every config-plane surface must be mounted, not just parsed. */

import { describe, expect, it } from "vitest";
import http from "../http";

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

  // Redeeming happens in a browser with no credential, so it must resolve on a
  // bare GET. Convex serves HEAD from the same route.
  it("mounts download redemption for unauthenticated GET", () => {
    expect(http.lookup("/v1/downloads/abcdefghijklmnop", "GET")).toBeTruthy();
  });
});
