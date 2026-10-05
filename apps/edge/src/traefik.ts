/**
 * Renders the route table as Traefik configuration: a file-provider config for
 * the local stack and self-hosting, and IngressRoute plus Middleware resources
 * for the cluster. Both share the same routers and middlewares, so every
 * environment routes and stamps headers the same way.
 *
 * Routes that share an upstream, a limit and logging become one router, its
 * rule the OR of theirs. Traefik keeps a rate-limit bucket per router, so fewer
 * routers means a client's per-address limit holds across the API: one bucket
 * for core, one for the config plane, one for upgrades.
 */
import { ROUTES, type EdgeRoute, type Upstream } from "./routes.ts";

/** Above any default priority Traefik gives the per-host Ingress routers. */
const PRIORITY_BASE = 1000;
const PREFIX = "broods-edge";

/** Browser origins allowed to call the API, as hostnames; `*.` matches subdomains. */
export const DEFAULT_ORIGINS = [
  "broods.app",
  "*.broods.app",
  "localhost",
  "127.0.0.1",
] as const;

// Bodies of every middleware but `headers`, identical in the file provider and
// the CRD `spec`.
const FIXED_MIDDLEWARES = {
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

type MiddlewareName = keyof typeof FIXED_MIDDLEWARES | "headers";
type MiddlewareBody =
  | (typeof FIXED_MIDDLEWARES)[keyof typeof FIXED_MIDDLEWARES]
  | ReturnType<typeof headersMiddleware>;
type Destination = Exclude<Upstream, "blocked">;

/** Routes that render as one router. */
interface RouterGroup {
  name: string;
  routes: EdgeRoute[];
  /** Position of the group's first route in the table. */
  index: number;
}

export interface FileRouter {
  rule: string;
  priority: number;
  entryPoints: string[];
  middlewares: string[];
  service: string;
  observability?: { accessLogs: false };
}

export interface FileConfig {
  http: {
    routers: Record<string, FileRouter>;
    middlewares: Record<string, MiddlewareBody>;
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

/**
 * File-provider config for one host, with each upstream's base URL and the
 * browser origins to allow. No per-address limits: locally every request shares
 * one address, and a self-hosted install mostly serves its owner.
 */
export function renderFileConfig(
  upstreams: Record<Destination, string>,
  entryPoint: string,
  origins: readonly string[] = DEFAULT_ORIGINS,
): FileConfig {
  const routers: Record<string, FileRouter> = {};
  for (const group of routerGroups()) {
    routers[`${PREFIX}-${group.name}`] = {
      rule: groupRule(group),
      priority: priority(group.index),
      entryPoints: [entryPoint],
      middlewares: groupMiddlewares(group, false).map(middlewareName),
      service: `${PREFIX}-${destination(group)}`,
      ...observability(group),
    };
  }
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
        Object.entries(middlewares(origins)).map(([name, body]) => [
          middlewareName(name),
          body,
        ]),
      ),
      services: services,
    },
  };
}

/**
 * The shared Middlewares, then one IngressRoute per stage. `limits` turns on the
 * per-address limits; leave it off until the client address survives the load
 * balancer, or every client shares one bucket.
 */
export function renderKubernetes(
  stages: readonly KubeStage[],
  namespace: string,
  limits: boolean,
): KubeResource[] {
  const resources: KubeResource[] = Object.entries(
    middlewares(DEFAULT_ORIGINS),
  ).map(([name, body]) => ({
    apiVersion: "traefik.io/v1alpha1",
    kind: "Middleware",
    metadata: { name: middlewareName(name), namespace: namespace },
    spec: body,
  }));
  for (const stage of stages) {
    resources.push({
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: { name: `${PREFIX}-${stage.name}`, namespace: namespace },
      spec: {
        entryPoints: ["websecure"],
        routes: routerGroups().map((group) => {
          const service = stage.upstreams[destination(group)];

          return {
            kind: "Rule",
            match: `Host(\`${stage.host}\`) && (${groupRule(group)})`,
            priority: priority(group.index),
            middlewares: groupMiddlewares(group, limits).map((name) => ({
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
            ...observability(group),
          };
        }),
        tls: { secretName: stage.tlsSecret },
      },
    });
  }

  return resources;
}

/**
 * The routes grouped into routers, highest priority first. A group takes the
 * priority of its first route, which keeps the table's order as long as no
 * request matches a later route of an earlier group ahead of another group's
 * route; the edge tests check that against the table.
 */
export function routerGroups(): RouterGroup[] {
  const groups = new Map<string, RouterGroup>();
  ROUTES.forEach((route, index) => {
    const name = [
      route.upstream,
      route.limit,
      ...(route.secretPath ? ["unlogged"] : []),
    ].join("-");
    const group = groups.get(name);
    if (group) group.routes.push(route);
    else groups.set(name, { name: name, routes: [route], index: index });
  });

  return [...groups.values()];
}

/** The Traefik rule for one route; trailing slashes match here and are stripped by a middleware. */
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

// A blocked group still names a service, which it never reaches.
function destination(group: RouterGroup): Destination {
  const upstream = group.routes[0]!.upstream;

  return upstream === "blocked" ? "core" : upstream;
}

// Headers first, so a 429 still carries CORS and the browser can read it.
function groupMiddlewares(
  group: RouterGroup,
  limits: boolean,
): MiddlewareName[] {
  const { upstream, limit } = group.routes[0]!;
  if (upstream === "blocked") return ["blocked"];
  const limiter: MiddlewareName[] =
    !limits || limit === "none" ? [] : [`limit-${limit}`];

  return ["headers", ...limiter, "strip-trailing-slash"];
}

function groupRule(group: RouterGroup): string {
  if (group.routes.length === 1) return routeRule(group.routes[0]!);

  return group.routes.map((route) => `(${routeRule(route)})`).join(" || ");
}

// Core and the config plane refuse the in-cluster service token on any request
// carrying `x-broods-via-gateway`, so every public request must carry it. An
// empty value removes the header: the service token picks its account from
// `X-Account-Id`, and only in-cluster callers may send it.
function headersMiddleware(origins: readonly string[]): {
  headers: Record<string, unknown>;
} {
  return {
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
      accessControlAllowOriginListRegex: origins.map(originRegex),
      accessControlMaxAge: 600,
      addVaryHeader: true,
    },
  };
}

function middlewareName(name: string): string {
  return `${PREFIX}-${name}`;
}

function middlewares(
  origins: readonly string[],
): Record<MiddlewareName, MiddlewareBody> {
  return { headers: headersMiddleware(origins), ...FIXED_MIDDLEWARES };
}

function observability(group: RouterGroup): Pick<FileRouter, "observability"> {
  return group.routes[0]!.secretPath
    ? { observability: { accessLogs: false } }
    : {};
}

// Any scheme and port, as the gateway's origin check matches the hostname only.
function originRegex(hostname: string): string {
  const subdomains = hostname.startsWith("*.");
  const escaped = (subdomains ? hostname.slice(2) : hostname).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );

  return `^https?://${subdomains ? "(?:[a-z0-9-]+\\.)+" : ""}${escaped}(?::\\d+)?$`;
}

function priority(index: number): number {
  return PRIORITY_BASE + ROUTES.length - index;
}
