/**
 * The rendered Traefik routers pick the same route as the table for raw paths,
 * trailing slashes included, and every public route stamps the gateway marker.
 */

import { expect, test } from "bun:test";
import { ROUTES, resolveRoute } from "../src/routes.ts";
import {
  renderFileConfig,
  renderKubernetes,
  type KubeResource,
} from "../src/traefik.ts";

const UPSTREAMS = {
  config: "http://config",
  core: "http://core",
  gateway: "http://gateway",
};
const SAMPLES = [
  "/",
  "/healthz/",
  "/v1",
  "/v1/account",
  "/v1/account//",
  "/v1/account/stage-session",
  "/v1/accounts/a/rotate-secret/",
  "/v1/agents",
  "/v1/agents/a",
  "/v1/agents/a/ws",
  "/v1/agents/a/channels/slack/directory",
  "/v1/projects/p/stages/s/agents/a/ws",
  "/v1/projects/p/stages/s/observability/ws/",
  "/v1/sandboxes/terminal/ws",
  "/v1/machines/ws",
  "/v1/env/NAME",
  "/v1/downloads/t",
  "/v1/workspaces/w/download-links",
  "/v1/workspaces/w/files",
  "/v1/crons/c/runs",
  "/v1/cron-runs/",
  "/v1/mcp-service/rpc",
  "/v1/webhooks/acct/slack",
  "/v1/runs",
  "/v2/agents",
];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

test("rendered rules route like the table", (): void => {
  const routers = Object.entries(
    renderFileConfig(UPSTREAMS, "web").http.routers,
  ).sort(([, a], [, b]) => b.priority - a.priority);

  for (const path of SAMPLES) {
    for (const method of METHODS) {
      for (const upgrade of [false, true]) {
        const headers: Record<string, string> = upgrade
          ? { Upgrade: "WebSocket" }
          : {};
        const matched = routers.find(([, router]) =>
          ruleMatches(router.rule, method, path, headers),
        );
        const expected = resolveRoute(method, path, upgrade);
        expect(`${method} ${path} ${upgrade}: ${matched?.[0] ?? "none"}`).toBe(
          `${method} ${path} ${upgrade}: ${expected ? `broods-edge-${expected.name}` : "none"}`,
        );
      }
    }
  }
});

test("every route but the blocked one marks the request as public", (): void => {
  const { routers } = renderFileConfig(UPSTREAMS, "web").http;

  for (const route of ROUTES) {
    const middlewares = routers[`broods-edge-${route.name}`]!.middlewares;
    expect(middlewares[0]).toBe(
      route.upstream === "blocked"
        ? "broods-edge-blocked"
        : "broods-edge-headers",
    );
  }
});

test("the cluster limits per address, except webhooks", (): void => {
  const spec = JSON.stringify(clusterResources());

  expect(spec).toContain(
    '"match":"Host(`gateway.dev.example`) && PathRegexp(`^/v1/webhooks/[^/].*/*$`)","priority":1002,"middlewares":[{"name":"broods-edge-headers"},{"name":"broods-edge-strip-trailing-slash"}]',
  );
  expect(spec).toContain(
    '"match":"Host(`gateway.dev.example`) && PathRegexp(`^/v1(?:/.*)?/*$`)","priority":1001,"middlewares":[{"name":"broods-edge-headers"},{"name":"broods-edge-limit-http"}',
  );
});

// A download link's token is its path, and it lives up to 30 days.
test("the download route stays out of the access log", (): void => {
  const { routers } = renderFileConfig(UPSTREAMS, "web").http;

  expect(routers["broods-edge-download"]!.observability).toEqual({
    accessLogs: false,
  });
  expect(routers["broods-edge-download-links"]!.observability).toBeUndefined();
  expect(JSON.stringify(clusterResources())).toContain(
    '"passHostHeader":false}],"observability":{"accessLogs":false}',
  );
});

test("the file config has no per-address limits", (): void => {
  const { routers } = renderFileConfig(UPSTREAMS, "web").http;

  for (const router of Object.values(routers)) {
    expect(router.middlewares.join()).not.toContain("limit");
  }
});

test("each stage gets its own host and the shared middlewares once", (): void => {
  const resources = clusterResources();
  const route = resources.find((resource) => resource.kind === "IngressRoute");

  expect(resources.filter((r) => r.kind === "Middleware")).toHaveLength(5);
  expect(JSON.stringify(route?.spec)).toContain(
    "Host(`gateway.dev.example`) && PathRegexp(`^/v1(?:/.*)?/*$`)",
  );
});

function clusterResources(): KubeResource[] {
  return renderKubernetes(
    [
      {
        name: "development",
        host: "gateway.dev.example",
        tlsSecret: "gateway-dev-tls",
        upstreams: {
          config: { name: "convex", namespace: "convex", port: 3211 },
          core: { name: "core-dev", port: 80 },
          gateway: { name: "gateway-dev", port: 80 },
        },
      },
    ],
    "beeblast",
  );
}

// Evaluates the three matchers the renderer emits. Go's `(?i)` prefix becomes
// the JavaScript `i` flag; the rest of the syntax used is shared.
function ruleMatches(
  rule: string,
  method: string,
  path: string,
  headers: Record<string, string>,
): boolean {
  const pathRegex = rule.match(/PathRegexp\(`([^`]+)`\)/)![1]!;
  if (!new RegExp(pathRegex).test(path)) return false;
  const methods = [...rule.matchAll(/Method\(`([A-Z]+)`\)/g)].map((m) => m[1]);
  if (methods.length && !methods.includes(method)) return false;
  const header = rule.match(/HeaderRegexp\(`([^`]+)`, `\(\?i\)([^`]+)`\)/);
  if (header) {
    return new RegExp(header[2]!, "i").test(headers[header[1]!] ?? "");
  }

  return true;
}
