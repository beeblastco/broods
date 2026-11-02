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

const FIXED_MIDDLEWARES = {
  // The burst leaves room for a CLI deploy.
  "limit-http": { rateLimit: { average: 20, period: "1s", burst: 200 } },
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

export interface KubeService {
  name: string;
  namespace?: string;
  port: number;
}

export interface KubeStage {
  name: string;
  host: string;
  tlsSecret: string;
  upstreams: Record<Upstream, KubeService>;
}

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

/** No per-address limits: locally every request shares one address. */
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

export function renderKubernetes(
  stages: readonly KubeStage[],
  namespace: string,
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
            middlewares: routerMiddlewares(router, true).map((name) => ({
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

// Core and the config plane refuse the service token on any request with the via header.
// The empty value strips `X-Account-Id`, the account pick only in-cluster callers may send.
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
        "x-broods-user-token",
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

// Hostname only, any scheme and port, `*` for all: the same as the gateway's origin check.
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

// Trailing slashes match here; the strip-trailing-slash middleware removes them.
function ruleMatcher(rule: EdgeRule): string {
  const path = `PathRegexp(\`^${rule.path}/*$\`)`;
  if (!rule.methods) return path;
  const methods = rule.methods.map((method) => `Method(\`${method}\`)`);

  return `(${methods.join(" || ")}) && ${path}`;
}
