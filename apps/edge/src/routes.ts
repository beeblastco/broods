/**
 * The public route table: which upstream a request to the API host reaches.
 * `traefik.ts` renders it as Traefik routers for every environment, and
 * `verification/Broods/Gateway.lean` models it. A route added to core or the
 * config plane must be added here too, or it lands on the wrong upstream.
 *
 * Order is priority: the first route whose path, method and upgrade match wins.
 */

export const METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export type Method = (typeof METHODS)[number];

/** `blocked` never reaches an upstream: in-cluster callers only. */
export type Upstream = "blocked" | "config" | "core" | "gateway";

/** Which per-address rate limit a route spends. */
export type Limit = "http" | "none" | "upgrade";

export interface EdgeRoute {
  name: string;
  /** Anchored path regex without `^` and `$`; trailing slashes are stripped first. */
  path: string;
  /** Every method when absent. */
  methods?: readonly Method[];
  upstream: Upstream;
  limit: Limit;
  /** Matches only a WebSocket upgrade; any other route matches both. */
  upgrade?: boolean;
  /** The path itself is a credential, so the access log skips this route. */
  secretPath?: boolean;
}

const SEGMENT = "[^/]+";

export const ROUTES: readonly EdgeRoute[] = [
  {
    name: "health",
    path: "/(?:healthz)?",
    methods: ["GET"],
    upstream: "gateway",
    limit: "none",
  },
  {
    name: "internal",
    path: "/v1/(?:cron-runs|mcp-service/rpc)",
    upstream: "blocked",
    limit: "none",
  },
  {
    name: "terminal-ws",
    path: "/v1/sandboxes/terminal/ws",
    upstream: "gateway",
    limit: "upgrade",
    upgrade: true,
  },
  {
    name: "machine-ws",
    path: "/v1/machines/ws",
    upstream: "gateway",
    limit: "upgrade",
    upgrade: true,
  },
  {
    name: "observability-ws",
    path: `/v1/projects/${SEGMENT}/stages/${SEGMENT}/observability/ws`,
    upstream: "gateway",
    limit: "upgrade",
    upgrade: true,
  },
  {
    name: "agent-ws",
    path: `/v1/(?:projects/${SEGMENT}/stages/${SEGMENT}/)?agents/${SEGMENT}/ws`,
    upstream: "gateway",
    limit: "upgrade",
    upgrade: true,
  },
  config("account", "/v1/account", ["GET", "PATCH"]),
  config("account-sub", "/v1/account/.*[^/]"),
  config("accounts", "/v1/accounts", ["GET"]),
  config("account-item", `/v1/accounts/${SEGMENT}`, ["GET", "PATCH"]),
  config("account-rotate", `/v1/accounts/${SEGMENT}/rotate-secret`, ["POST"]),
  config("agents", "/v1/agents", ["GET", "POST"]),
  config("agent-item", `/v1/agents/${SEGMENT}`, ["GET", "PATCH", "DELETE"]),
  config(
    "agent-directory",
    `/v1/agents/${SEGMENT}/channels/${SEGMENT}/directory`,
    ["GET"],
  ),
  config("env", "/v1/env", ["GET"]),
  config("env-item", `/v1/env/${SEGMENT}`, ["PUT", "DELETE"]),
  // Redeeming a workspace download link. Unauthenticated by design: the token
  // in the path is the credential, and the config plane answers with a 302.
  {
    ...config("download", `/v1/downloads/${SEGMENT}`, ["GET", "HEAD"]),
    secretPath: true,
  },
  config("download-links", `/v1/workspaces/${SEGMENT}/download-links`, [
    "POST",
  ]),
  config(
    "resources",
    `/v1/(?:skills|mcp|hooks|workspaces|sandboxes|policies|roles|channels|crons)(?:/${SEGMENT})?`,
  ),
  config("workspace-files", `/v1/workspaces/${SEGMENT}/files`),
  config("cron-runs", `/v1/crons/${SEGMENT}/runs`),
  // Channel providers post from shared egress addresses, so no per-address limit.
  {
    name: "webhooks",
    path: "/v1/webhooks/.*[^/]",
    upstream: "core",
    limit: "none",
  },
  { name: "core", path: "/v1(?:/.*)?", upstream: "core", limit: "http" },
];

/**
 * The route a request takes, or null for a 404. Mirrors what the rendered
 * Traefik routers do, so tests and the Lean model can check the table itself.
 */
export function resolveRoute(
  method: string,
  pathname: string,
  upgrade: boolean,
): EdgeRoute | null {
  const path = stripTrailingSlashes(pathname);
  const upper = method.toUpperCase();

  return (
    ROUTES.find(
      (route) =>
        (upgrade || !route.upgrade) &&
        (!route.methods || route.methods.some((m) => m === upper)) &&
        new RegExp(`^${route.path}$`).test(path),
    ) ?? null
  );
}

/** `/v1/agents/` and `/v1/agents` are one route; `/` stays `/`. */
export function stripTrailingSlashes(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function config(
  name: string,
  path: string,
  methods?: readonly Method[],
): EdgeRoute {
  return {
    name: name,
    path: path,
    ...(methods ? { methods: methods } : {}),
    upstream: "config",
    limit: "http",
  };
}
