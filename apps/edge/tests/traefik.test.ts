/**
 * The rendered Traefik routers pick the router the table picks, for raw paths
 * with trailing slashes included, and every router stamps the gateway marker.
 */

import { expect, test } from "bun:test";
import { resolveRouter } from "../src/routes.ts";
import {
  renderFileConfig,
  renderKubernetes,
  type KubeResource,
  type KubeRoute,
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
  "/v1/media/ml1abc",
  "/v1/media//",
  "/v1/webhooks/acct/slack",
  "/v1/webhooks//",
  "/v1/runs",
  "/v2/agents",
];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

test("rendered rules route like the table", (): void => {
  const routers = Object.entries(renderFileConfig(UPSTREAMS).http.routers).sort(
    ([, a], [, b]) => b.priority - a.priority,
  );

  for (const path of SAMPLES) {
    for (const method of METHODS) {
      const matched = routers.find(([, router]) =>
        ruleMatches(router.rule, method, path),
      );
      const expected = resolveRouter(method, path);
      expect(`${method} ${path}: ${matched?.[0] ?? "none"}`).toBe(
        `${method} ${path}: ${expected ? `broods-edge-${expected.name}` : "none"}`,
      );
    }
  }
});

test("every router marks the request as public first", (): void => {
  for (const router of Object.values(
    renderFileConfig(UPSTREAMS).http.routers,
  )) {
    expect(router.middlewares[0]).toBe("broods-edge-headers");
  }
});

// Traefik keeps a bucket per router, so the per-address limit holds only if
// few routers count against it.
test("the cluster limits HTTP in three routers and upgrades in one", (): void => {
  const limited = (name: string): string[] =>
    clusterRoutes(true)
      .filter((route) => JSON.stringify(route.middlewares).includes(name))
      .map((route) => route.match);

  expect(limited("limit-http")).toHaveLength(3);
  expect(limited("limit-upgrade")).toHaveLength(1);
  expect(limited("limit-http").join()).not.toMatch(/webhooks|media/);
});

test("the cluster limits nothing until asked to", (): void => {
  expect(JSON.stringify(clusterRoutes(false))).not.toContain("limit-");
});

// Download and media links carry their credential in the path.
test("download and media links stay out of the access log", (): void => {
  const unlogged = Object.entries(renderFileConfig(UPSTREAMS).http.routers)
    .filter(([, router]) => router.observability?.accessLogs === false)
    .map(([name]) => name);

  expect(unlogged).toEqual(["broods-edge-downloads", "broods-edge-media"]);
});

test("a self-hosted install allows its own origins", (): void => {
  const origins = (list: string[]): string =>
    JSON.stringify(
      renderFileConfig(UPSTREAMS, list).http.middlewares["broods-edge-headers"],
    );

  expect(origins(["agents.example.com", "*.example.org"])).toContain(
    "^https?://agents\\\\.example\\\\.com(?::\\\\d+)?$",
  );
  expect(origins(["*.example.org"])).toContain(
    "^https?://(?:[a-z0-9-]+\\\\.)+example\\\\.org(?::\\\\d+)?$",
  );
  expect(origins(["*"])).toContain('"^https?://.+$"');
  expect(origins(["agents.example.com"])).not.toContain("broods\\\\.app");
});

function clusterRoutes(limits: boolean): KubeRoute[] {
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
  for (const resource of resources) {
    if (resource.kind === "IngressRoute") return resource.spec.routes;
  }

  return [];
}

// Evaluates the matchers the renderer emits: OR'ed rules of Method and
// PathRegexp. The regex syntax used is shared by Go and JavaScript.
function ruleMatches(rule: string, method: string, path: string): boolean {
  return topLevelAlternatives(rule).some((member) => {
    const pathRegex = member.match(/PathRegexp\(`([^`]+)`\)/)![1]!;
    if (!new RegExp(pathRegex).test(path)) return false;
    const methods = [...member.matchAll(/Method\(`([A-Z]+)`\)/g)].map(
      (m) => m[1],
    );

    return !methods.length || methods.includes(method);
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
