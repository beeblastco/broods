import { describe, expect, it } from "vitest";
import http from "../http";
import { handle as cliHttp } from "../cli/http";
import { httpHandle as cliProjectsHttp } from "../cli/projects";
import { httpHandle as cliStagesHttp } from "../cli/stages";
import { handle as configHttp } from "../config/http";

// configHttp can dispatch a surface the router never mounted, which still answers 404.
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
    path: "/v1/roles",
    collection: ["GET", "POST"],
    item: ["GET", "PATCH", "DELETE"],
  },
  {
    path: "/v1/skills",
    collection: ["GET", "POST"],
    item: ["GET", "PUT", "DELETE"],
  },
  {
    path: "/v1/mcp",
    collection: ["GET", "POST"],
    // POST on the item path is /v1/mcp/uploads, not a per-server write.
    item: ["GET", "POST", "PATCH", "DELETE"],
  },
  {
    path: "/v1/workspaces",
    collection: ["GET", "POST"],
    item: ["GET", "PATCH", "DELETE"],
  },
];

describe("config-plane HTTP routes", () => {
  it.each(SURFACES)("mounts $path", (surface) => {
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

  it("mounts workspace file and download-link surfaces", () => {
    expect(http.lookup("/v1/workspaces/ws_1/files", "GET")).toBeTruthy();
    expect(http.lookup("/v1/workspaces/ws_1/files", "POST")).toBeTruthy();
    expect(
      http.lookup("/v1/workspaces/ws_1/download-links", "POST"),
    ).toBeTruthy();
  });

  // `/v1/account/projects/` is a pathPrefix that would swallow a nested stage route, so
  // assert which handler wins, not just that one matched.
  it("mounts the CLI stage surface on its own handler", () => {
    for (const method of ["GET", "POST"] as const) {
      const route = http.lookup("/v1/account/stages", method);
      expect(route, `${method} /v1/account/stages`).toBeTruthy();
      expect(route?.[0], `${method} /v1/account/stages`).toBe(cliStagesHttp);
    }
  });

  // Sits right above cliHttp's `/v1/account/projects/` pathPrefix: assert the handler.
  it("mounts the CLI project surface on its own handler", () => {
    for (const method of ["GET", "DELETE"] as const) {
      const route = http.lookup("/v1/account/projects", method);
      expect(route, `${method} /v1/account/projects`).toBeTruthy();
      expect(route?.[0], `${method} /v1/account/projects`).toBe(
        cliProjectsHttp,
      );
    }
  });

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

  it("mounts the audit ledger, its verify leaf and its sink", () => {
    expect(http.lookup("/v1/audit", "GET")).toBeTruthy();
    expect(http.lookup("/v1/audit/verify", "GET")).toBeTruthy();
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      expect(http.lookup("/v1/audit/sink", method)).toBeTruthy();
    }
    expect(http.lookup("/v1/audit", "POST")).toBeFalsy();
    expect(http.lookup("/v1/audit/sink", "POST")).toBeFalsy();
  });

  // Redeemed by a browser with no credential; Convex serves HEAD from the same route.
  it("mounts download redemption for unauthenticated GET", () => {
    expect(http.lookup("/v1/downloads/abcdefghijklmnop", "GET")).toBeTruthy();
  });

  // Sits beside the `/v1/account/projects/` pathPrefix mounts: assert the handler.
  it("mounts assume-role on the config-plane handler", () => {
    const route = http.lookup("/v1/account/assume-role", "POST");
    expect(route, "POST /v1/account/assume-role").toBeTruthy();
    expect(route?.[0], "POST /v1/account/assume-role").toBe(configHttp);
  });
});
