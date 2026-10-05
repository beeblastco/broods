/**
 * The rendered Traefik routers pick the router of the route the table picks,
 * for raw paths with trailing slashes included, and every public router stamps
 * the gateway marker.
 */

import { expect, test } from "bun:test";
import { resolveRoute } from "../src/routes.ts";
import {
  renderFileConfig,
  renderKubernetes,
  routerGroups,
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
  "/v1/account//x",
  "/v1/account/stage-session",
  "/v1/accounts/a/rotate-secret/",
  "/v1/agents",
  "/v1/agents/a",
  "/v1/agents/a/ws",
  "/v1/agents/a/channels/slack/directory",
  "/v1/projects/p/stages/s/agents/a/ws",
  "/v1/projects/p/stages/s/observability/ws/",
  "/v1/sandboxes/terminal/ws",
  "/v1/sandboxes/s",
  "/v1/machines/ws",
  "/v1/env/NAME",
  "/v1/downloads/t",
  "/v1/workspaces/w/download-links",
  "/v1/workspaces/w/files",
  "/v1/crons/c/runs",
  "/v1/cron-runs/",
  "/v1/mcp-service/rpc",
  "/v1/webhooks/acct/slack",
  "/v1/webhooks//",
  "/v1/runs",
  "/v2/agents",
];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

test("rendered rules route like the table", (): void => {
  const routers = Object.entries(
    renderFileConfig(UPSTREAMS, "web").http.routers,
  ).sort(([, a], [, b]) => b.priority - a.priority);
  const groupOf = new Map(
    routerGroups().flatMap((group) =>
      group.routes.map((route) => [route.name, `broods-edge-${group.name}`]),
    ),
  );

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
          `${method} ${path} ${upgrade}: ${expected ? groupOf.get(expected.name) : "none"}`,
        );
      }
    }
  }
});

test("every router but the blocked one marks the request as public", (): void => {
  const { routers } = renderFileConfig(UPSTREAMS, "web").http;

  for (const [name, router] of Object.entries(routers)) {
    expect(router.middlewares[0]).toBe(
      name === "broods-edge-blocked-none"
        ? "broods-edge-blocked"
        : "broods-edge-headers",
    );
  }
});

// Traefik keeps a bucket per router, so the per-address limit holds only if
// few routers count against it.
test("the cluster limits HTTP in three routers and upgrades in one", (): void => {
  const routes = clusterRoutes(true);
  const limited = (name: string): string[] =>
    routes
      .filter((route) => JSON.stringify(route.middlewares).includes(name))
      .map((route) => route.match);

  expect(limited("limit-http")).toHaveLength(3);
  expect(limited("limit-upgrade")).toHaveLength(1);
  expect(limited("limit-http").join()).not.toContain("webhooks");
});

test("the cluster limits nothing until asked to", (): void => {
  expect(JSON.stringify(clusterRoutes(false))).not.toContain("limit-");
});

// A download link's token is its path, and it lives up to 30 days.
test("the download route stays out of the access log", (): void => {
  const { routers } = renderFileConfig(UPSTREAMS, "web").http;
  const unlogged = Object.entries(routers).filter(
    ([, router]) => router.observability?.accessLogs === false,
  );

  expect(unlogged).toHaveLength(1);
  expect(unlogged[0]![1].rule).toBe(
    "PathRegexp(`^/v1/downloads/[^/]+/*$`) && (Method(`GET`) || Method(`HEAD`))",
  );
});

test("a self-hosted install allows its own origins", (): void => {
  const { middlewares } = renderFileConfig(UPSTREAMS, "web", [
    "agents.example.com",
    "*.example.org",
  ]).http;
  const origins = JSON.stringify(middlewares["broods-edge-headers"]);

  expect(origins).toContain(
    "^https?://agents\\\\.example\\\\.com(?::\\\\d+)?$",
  );
  expect(origins).toContain(
    "^https?://(?:[a-z0-9-]+\\\\.)+example\\\\.org(?::\\\\d+)?$",
  );
  expect(origins).not.toContain("broods\\\\.app");
});

function clusterRoutes(
  limits: boolean,
): { match: string; middlewares: { name: string }[] }[] {
  const resources: KubeResource[] = renderKubernetes(
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
    limits,
  );
  const ingress = resources.find(
    (resource) => resource.kind === "IngressRoute",
  );

  return (
    ingress?.spec as {
      routes: { match: string; middlewares: { name: string }[] }[];
    }
  ).routes;
}

// Evaluates the matchers the renderer emits: OR'ed groups of PathRegexp,
// Method and HeaderRegexp. Go's `(?i)` prefix becomes the JavaScript `i` flag;
// the rest of the regex syntax used is shared.
function ruleMatches(
  rule: string,
  method: string,
  path: string,
  headers: Record<string, string>,
): boolean {
  return topLevelAlternatives(rule).some((member) => {
    const pathRegex = member.match(/PathRegexp\(`([^`]+)`\)/)![1]!;
    if (!new RegExp(pathRegex).test(path)) return false;
    const methods = [...member.matchAll(/Method\(`([A-Z]+)`\)/g)].map(
      (m) => m[1],
    );
    if (methods.length && !methods.includes(method)) return false;
    const header = member.match(/HeaderRegexp\(`([^`]+)`, `\(\?i\)([^`]+)`\)/);

    return header
      ? new RegExp(header[2]!, "i").test(headers[header[1]!] ?? "")
      : true;
  });
}

// Splits a rule on the `||` outside any parentheses or backticks.
function topLevelAlternatives(rule: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < rule.length; i++) {
    const char = rule[i];
    if (char === "`") quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0 && rule.startsWith(" || ", i)) {
      members.push(rule.slice(start, i));
      start = i + 4;
    }
  }
  members.push(rule.slice(start));

  return members;
}
