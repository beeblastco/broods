/**
 * Renders the route table as Traefik configuration: a file-provider config for
 * the local stack and self-hosting, and IngressRoute plus Middleware resources
 * for the cluster. Both share the same routers and middlewares, so every
 * environment routes and stamps headers the same way. Each table router is one
 * Traefik router, so priority follows the table and each router is one
 * rate-limit bucket.
 */
import { VIA_GATEWAY_HEADER } from "../../../packages/convex/model/serviceBridge.ts";
import { DEFAULT_ORIGINS } from "./origins.ts";
import {
  METHODS,
  ROUTERS,
  type EdgeRouter,
  type EdgeRule,
  type Upstream,
} from "./routes.ts";

const ENTRY_POINT = "web";
const PREFIX = "broods-edge";
/** Above any default priority Traefik gives the per-host Ingress routers. */
const PRIORITY_BASE = 1000;

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
} as const;

type MiddlewareName = keyof typeof FIXED_MIDDLEWARES | "headers";
type MiddlewareBody =
  | (typeof FIXED_MIDDLEWARES)[keyof typeof FIXED_MIDDLEWARES]
  | ReturnType<typeof headersMiddleware>;

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
  upstreams: Record<Upstream, KubeService>;
}

/** One route of an IngressRoute: a rendered router for one host. */
export interface KubeRoute {
  kind: "Rule";
  match: string;
  priority: number;
  middlewares: { name: string }[];
  services: (KubeService & { passHostHeader: false })[];
  observability?: { accessLogs: false };
}

export type KubeResource = {
  apiVersion: "traefik.io/v1alpha1";
  metadata: { name: string; namespace: string };
} & (
  | { kind: "Middleware"; spec: MiddlewareBody }
  | {
      kind: "IngressRoute";
      spec: {
        entryPoints: string[];
        routes: KubeRoute[];
        tls: { secretName: string };
      };
    }
);

/**
 * File-provider config for one host, with each upstream's base URL and the
 * browser origins to allow. No per-address limits: locally every request shares
 * one address, and a self-hosted install mostly serves its owner.
 */
export function renderFileConfig(
  upstreams: Record<Upstream, string>,
  origins: readonly string[] = DEFAULT_ORIGINS,
): FileConfig {
  const routers: Record<string, FileRouter> = {};
  ROUTERS.forEach((router, index) => {
    routers[`${PREFIX}-${router.name}`] = {
      rule: routerRule(router),
      priority: priority(index),
      entryPoints: [ENTRY_POINT],
      middlewares: routerMiddlewares(router, false).map(middlewareName),
      service: `${PREFIX}-${router.upstream}`,
      ...observability(router),
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
        routes: ROUTERS.map((router, index): KubeRoute => {
          const service = stage.upstreams[router.upstream];

          return {
            kind: "Rule",
            match: `Host(\`${stage.host}\`) && (${routerRule(router)})`,
            priority: priority(index),
            middlewares: routerMiddlewares(router, limits).map((name) => ({
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
            ...observability(router),
          };
        }),
        tls: { secretName: stage.tlsSecret },
      },
    });
  }

  return resources;
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
      customRequestHeaders: { [VIA_GATEWAY_HEADER]: "1", "X-Account-Id": "" },
      accessControlAllowMethods: [...METHODS],
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

function observability(router: EdgeRouter): Pick<FileRouter, "observability"> {
  return router.secretPath ? { observability: { accessLogs: false } } : {};
}

// Any scheme and port, as the gateway's origin check matches the hostname
// only; `*` allows every origin, as it does there.
function originRegex(hostname: string): string {
  if (hostname === "*") return "^https?://.+$";
  const subdomains = hostname.startsWith("*.");
  const escaped = (subdomains ? hostname.slice(2) : hostname).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );

  return `^https?://${subdomains ? "(?:[a-z0-9-]+\\.)+" : ""}${escaped}(?::\\d+)?$`;
}

function priority(index: number): number {
  return PRIORITY_BASE + ROUTERS.length - index;
}

// Headers first, so a 429 still carries CORS and the browser can read it.
function routerMiddlewares(
  router: EdgeRouter,
  limits: boolean,
): MiddlewareName[] {
  const limit: MiddlewareName[] =
    !limits || router.limit === "none" ? [] : [`limit-${router.limit}`];

  return ["headers", ...limit, "strip-trailing-slash"];
}

function routerRule(router: EdgeRouter): string {
  if (router.rules.length === 1) return ruleMatcher(router.rules[0]!);

  return router.rules.map((rule) => `(${ruleMatcher(rule)})`).join(" || ");
}

// The method check comes first: it is cheaper than the path regex. Trailing
// slashes match here and are stripped by a middleware.
function ruleMatcher(rule: EdgeRule): string {
  const path = `PathRegexp(\`^${rule.path}/*$\`)`;
  if (!rule.methods) return path;
  const methods = rule.methods.map((method) => `Method(\`${method}\`)`);

  return `(${methods.join(" || ")}) && ${path}`;
}
