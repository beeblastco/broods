/**
 * Renders the route table as Traefik configuration: a file-provider config for
 * the local stack and self-hosting, and IngressRoute plus Middleware resources
 * for the cluster. Both share the same routers and middlewares, so every
 * environment routes and stamps headers the same way. Only the cluster limits
 * per client address: locally every request shares one address, and a
 * self-hosted install mostly serves its owner.
 */
import { ROUTES, type EdgeRoute, type Upstream } from "./routes.ts";

/** Above any default priority Traefik gives the per-host Ingress routers. */
const PRIORITY_BASE = 1000;
const PREFIX = "broods-edge";

// Middleware bodies, identical in the file provider and the CRD `spec`.
const MIDDLEWARES = {
  // Core and the config plane refuse the in-cluster service token on any request
  // carrying `x-broods-via-gateway`, so every public request must carry it. An
  // empty value removes the header: the service token picks its account from
  // `X-Account-Id`, and only in-cluster callers may send it.
  headers: {
    headers: {
      customRequestHeaders: { "x-broods-via-gateway": "1", "X-Account-Id": "" },
      accessControlAllowMethods: [
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
      ],
      accessControlAllowHeaders: [
        "authorization",
        "content-type",
        "x-request-id",
      ],
      accessControlAllowOriginListRegex: [
        "^https?://(?:[a-z0-9-]+\\.)*broods\\.app(?::\\d+)?$",
        "^https?://(?:localhost|127\\.0\\.0\\.1)(?::\\d+)?$",
      ],
      accessControlMaxAge: 600,
      addVaryHeader: true,
    },
  },
  // 1200 a minute per address, with room for a CLI deploy's burst.
  "limit-http": { rateLimit: { average: 20, period: "1s", burst: 200 } },
  // 120 a minute per address.
  "limit-upgrade": { rateLimit: { average: 2, period: "1s", burst: 60 } },
  "strip-trailing-slash": {
    replacePathRegex: { regex: "^(/.*?)/+$", replacement: "$1" },
  },
  // No address is in this range, so nothing passes.
  blocked: { ipAllowList: { sourceRange: ["255.255.255.255/32"] } },
} as const;

type MiddlewareName = keyof typeof MIDDLEWARES;
type Destination = Exclude<Upstream, "blocked">;

export interface FileRouter {
  rule: string;
  priority: number;
  entryPoints: string[];
  middlewares: string[];
  service: string;
}

export interface FileConfig {
  http: {
    routers: Record<string, FileRouter>;
    middlewares: Record<string, (typeof MIDDLEWARES)[MiddlewareName]>;
    services: Record<
      string,
      { loadBalancer: { servers: { url: string }[]; passHostHeader: false } }
    >;
  };
}

/** A Kubernetes Service an IngressRoute forwards to. */
export interface KubeService {
  name: string;
  namespace?: string;
  port: number;
}

/** One public host in the cluster and the services behind it. */
export interface KubeStage {
  name: string;
  host: string;
  tlsSecret: string;
  upstreams: Record<Destination, KubeService>;
}

export interface KubeResource {
  apiVersion: "traefik.io/v1alpha1";
  kind: "IngressRoute" | "Middleware";
  metadata: { name: string; namespace: string };
  spec: object;
}

/** File-provider config for one host, with each upstream's base URL. No per-address limits. */
export function renderFileConfig(
  upstreams: Record<Destination, string>,
  entryPoint: string,
): FileConfig {
  const routers: Record<string, FileRouter> = {};
  ROUTES.forEach((route, index) => {
    routers[`${PREFIX}-${route.name}`] = {
      rule: routeRule(route),
      priority: priority(index),
      entryPoints: [entryPoint],
      middlewares: routeMiddlewares(route, false).map(middlewareName),
      service: `${PREFIX}-${destination(route)}`,
    };
  });
  const services: FileConfig["http"]["services"] = {};
  for (const [name, url] of Object.entries(upstreams)) {
    services[`${PREFIX}-${name}`] = {
      loadBalancer: { servers: [{ url: url }], passHostHeader: false },
    };
  }

  return {
    http: {
      routers: routers,
      middlewares: Object.fromEntries(
        Object.entries(MIDDLEWARES).map(([name, body]) => [
          middlewareName(name),
          body,
        ]),
      ),
      services: services,
    },
  };
}

/** The shared Middlewares, then one IngressRoute per stage. */
export function renderKubernetes(
  stages: readonly KubeStage[],
  namespace: string,
): KubeResource[] {
  const middlewares: KubeResource[] = Object.entries(MIDDLEWARES).map(
    ([name, body]) => ({
      apiVersion: "traefik.io/v1alpha1",
      kind: "Middleware",
      metadata: { name: middlewareName(name), namespace: namespace },
      spec: body,
    }),
  );
  const ingressRoutes: KubeResource[] = stages.map((stage) => ({
    apiVersion: "traefik.io/v1alpha1",
    kind: "IngressRoute",
    metadata: { name: `${PREFIX}-${stage.name}`, namespace: namespace },
    spec: {
      entryPoints: ["websecure"],
      routes: ROUTES.map((route, index) => {
        const service = stage.upstreams[destination(route)];

        return {
          kind: "Rule",
          match: `Host(\`${stage.host}\`) && ${routeRule(route)}`,
          priority: priority(index),
          middlewares: routeMiddlewares(route, true).map((name) => ({
            name: middlewareName(name),
          })),
          services: [
            {
              name: service.name,
              ...(service.namespace ? { namespace: service.namespace } : {}),
              port: service.port,
              passHostHeader: false,
            },
          ],
        };
      }),
      tls: { secretName: stage.tlsSecret },
    },
  }));

  return [...middlewares, ...ingressRoutes];
}

/** The Traefik rule for a route; trailing slashes match here and are stripped by a middleware. */
export function routeRule(route: EdgeRoute): string {
  const parts = [`PathRegexp(\`^${route.path}/*$\`)`];
  if (route.methods) {
    parts.push(
      `(${route.methods.map((method) => `Method(\`${method}\`)`).join(" || ")})`,
    );
  }
  if (route.upgrade) parts.push("HeaderRegexp(`Upgrade`, `(?i)^websocket$`)");

  return parts.join(" && ");
}

// A blocked route still names a service, which it never reaches.
function destination(route: EdgeRoute): Destination {
  return route.upstream === "blocked" ? "core" : route.upstream;
}

function middlewareName(name: string): string {
  return `${PREFIX}-${name}`;
}

function priority(index: number): number {
  return PRIORITY_BASE + ROUTES.length - index;
}

// Headers first, so a 429 still carries CORS and the browser can read it.
function routeMiddlewares(route: EdgeRoute, limits: boolean): MiddlewareName[] {
  if (route.upstream === "blocked") return ["blocked"];
  const limit: MiddlewareName[] =
    !limits || route.limit === "none" ? [] : [`limit-${route.limit}`];

  return ["headers", ...limit, "strip-trailing-slash"];
}
