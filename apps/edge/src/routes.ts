import { stripTrailingSlashes } from "../../core/src/shared/paths.ts";

export const METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

const SEGMENT = "[^/]+";

export type Method = (typeof METHODS)[number];

export type Upstream = "config" | "core" | "gateway";

export type Limit = "http" | "none" | "upgrade";

export interface EdgeRule {
  /** Anchored regex without `^` and `$`, matched after trailing slashes are stripped. */
  path: string;
  methods?: readonly Method[];
}

export interface EdgeRouter {
  name: string;
  upstream: Upstream;
  limit: Limit;
  secretPath?: true;
  rules: readonly EdgeRule[];
}

// First match wins, and each router is its own Traefik rate-limit bucket.
// verification/Broods/Gateway.lean models this table: change one, change the other.
export const ROUTERS: readonly EdgeRouter[] = [
  {
    name: "health",
    upstream: "gateway",
    limit: "none",
    rules: [{ path: "/(?:healthz)?", methods: ["GET"] }],
  },
  {
    name: "sockets",
    upstream: "gateway",
    limit: "upgrade",
    rules: [
      { path: "/v1/sandboxes/terminal/ws" },
      { path: "/v1/machines/ws" },
      { path: `/v1/projects/${SEGMENT}/stages/${SEGMENT}/observability/ws` },
      {
        path: `/v1/(?:projects/${SEGMENT}/stages/${SEGMENT}/)?agents/${SEGMENT}/ws`,
      },
    ],
  },
  // Unauthenticated by design: the token in the path is the credential.
  {
    name: "downloads",
    upstream: "config",
    limit: "http",
    secretPath: true,
    rules: [{ path: `/v1/downloads/${SEGMENT}`, methods: ["GET", "HEAD"] }],
  },
  // Method-aware: a method miss falls through to core.
  {
    name: "config",
    upstream: "config",
    limit: "http",
    rules: [
      { path: "/v1/account", methods: ["GET", "PATCH"] },
      { path: "/v1/account/.*[^/]" },
      { path: "/v1/accounts", methods: ["GET"] },
      { path: `/v1/accounts/${SEGMENT}`, methods: ["GET", "PATCH"] },
      { path: `/v1/accounts/${SEGMENT}/rotate-secret`, methods: ["POST"] },
      { path: "/v1/agents", methods: ["GET", "POST"] },
      { path: `/v1/agents/${SEGMENT}`, methods: ["GET", "PATCH", "DELETE"] },
      {
        path: `/v1/agents/${SEGMENT}/channels/${SEGMENT}/directory`,
        methods: ["GET"],
      },
      { path: "/v1/env", methods: ["GET"] },
      { path: `/v1/env/${SEGMENT}`, methods: ["PUT", "DELETE"] },
      { path: `/v1/workspaces/${SEGMENT}/download-links`, methods: ["POST"] },
      { path: "/v1/audit(?:/verify)?", methods: ["GET"] },
      { path: "/v1/audit/sink", methods: ["GET", "PUT", "DELETE"] },
      {
        path: `/v1/(?:skills|mcp|hooks|workspaces|sandboxes|policies|roles|channels|crons)(?:/${SEGMENT})?`,
      },
      { path: `/v1/workspaces/${SEGMENT}/files` },
      { path: `/v1/crons/${SEGMENT}/runs` },
    ],
  },
  // Providers post from shared egress addresses, hence no limit. Pancake's `?secret=` and a
  // Meta verification GET's `hub.verify_token` put a credential in the query string.
  {
    name: "secret-webhooks",
    upstream: "core",
    limit: "none",
    secretPath: true,
    rules: [
      { path: `/v1/webhooks/${SEGMENT}(?:/dev/${SEGMENT})?/pancake` },
      { path: "/v1/webhooks/.*[^/]", methods: ["GET"] },
    ],
  },
  {
    name: "webhooks",
    upstream: "core",
    limit: "none",
    rules: [{ path: "/v1/webhooks/.*[^/]" }],
  },
  {
    name: "media",
    upstream: "core",
    limit: "none",
    secretPath: true,
    rules: [{ path: "/v1/media/.*[^/]", methods: ["GET", "HEAD"] }],
  },
  {
    name: "core",
    upstream: "core",
    limit: "http",
    rules: [{ path: "/v1(?:/.*)?" }],
  },
];

export function resolveRouter(
  method: string,
  pathname: string,
): EdgeRouter | null {
  const path = stripTrailingSlashes(pathname) || "/";
  const upper = method.toUpperCase();

  return (
    ROUTERS.find((router) =>
      router.rules.some(
        (rule) =>
          (!rule.methods || rule.methods.some((m) => m === upper)) &&
          new RegExp(`^${rule.path}$`).test(path),
      ),
    ) ?? null
  );
}
