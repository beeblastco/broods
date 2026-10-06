/**
 * The public route table: which upstream a request to the API host reaches.
 * `traefik.ts` renders each router as one Traefik router, and
 * `verification/Broods/Gateway.lean` models the table. A route added to core or
 * the config plane must be added here too, or it lands on the wrong upstream.
 *
 * Order is priority: the first router with a matching rule wins. Each router is
 * one rate-limit bucket in Traefik, so a new router means a new bucket.
 */
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

/** Which per-address limit a router spends. */
export type Limit = "http" | "none" | "upgrade";

/** One path a router matches. */
export interface EdgeRule {
  /** Anchored path regex without `^` and `$`; trailing slashes are stripped first. */
  path: string;
  /** Every method when absent. */
  methods?: readonly Method[];
}

export interface EdgeRouter {
  name: string;
  upstream: Upstream;
  limit: Limit;
  /** The path itself is a credential, so the access log skips this router. */
  secretPath?: true;
  rules: readonly EdgeRule[];
}

export const ROUTERS: readonly EdgeRouter[] = [
  {
    name: "health",
    upstream: "gateway",
    limit: "none",
    rules: [{ path: "/(?:healthz)?", methods: ["GET"] }],
  },
  // The gateway answers anything but an upgrade on these with a 404.
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
  // Redeeming a workspace download link. Unauthenticated by design: the token
  // in the path is the credential, and the config plane answers with a 302.
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
      {
        path: `/v1/(?:skills|mcp|hooks|workspaces|sandboxes|policies|roles|channels|crons)(?:/${SEGMENT})?`,
      },
      { path: `/v1/workspaces/${SEGMENT}/files` },
      { path: `/v1/crons/${SEGMENT}/runs` },
    ],
  },
  // Channel providers post from shared egress addresses, so no per-address limit.
  {
    name: "webhooks",
    upstream: "core",
    limit: "none",
    rules: [{ path: "/v1/webhooks/.*[^/]" }],
  },
  // A media link never expires and its ticket is the path. Channel providers
  // fetch it from shared egress addresses, like webhooks.
  {
    name: "media",
    upstream: "core",
    limit: "none",
    secretPath: true,
    rules: [{ path: "/v1/media/.*[^/]", methods: ["GET", "HEAD"] }],
  },
  // Includes the in-cluster-only paths (`/v1/cron-runs`, `/v1/mcp-service/rpc`):
  // core refuses them without the service token, which is never valid on a
  // request the edge stamped.
  {
    name: "core",
    upstream: "core",
    limit: "http",
    rules: [{ path: "/v1(?:/.*)?" }],
  },
];

/**
 * The router a request takes, or null for a 404. Mirrors what the rendered
 * Traefik routers do, so tests and the Lean model can check the table itself.
 */
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
