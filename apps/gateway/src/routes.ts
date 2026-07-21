const observabilityWebSocketPattern =
  /^\/v1\/([^/]+)\/([^/]+)\/observability\/ws$/;

export function matchObservabilityWebSocketPath(
  pathname: string,
): RegExpMatchArray | null {
  return pathname.match(observabilityWebSocketPattern);
}

export function isConfigHttpPath(pathname: string, method = "GET"): boolean {
  const upperMethod = method.toUpperCase();

  if (pathname === "/v1/account")
    return upperMethod === "GET" || upperMethod === "PATCH";
  if (pathname.startsWith("/v1/account/")) return true;
  if (pathname === "/accounts") return upperMethod === "GET";
  if (/^\/accounts\/[^/]+$/.test(pathname))
    return upperMethod === "GET" || upperMethod === "PATCH";
  if (/^\/accounts\/[^/]+\/rotate-secret$/.test(pathname))
    return upperMethod === "POST";
  if (pathname === "/v1/agents")
    return upperMethod === "GET" || upperMethod === "POST";
  if (/^\/v1\/agents\/[^/]+$/.test(pathname))
    return ["GET", "PATCH", "DELETE"].includes(upperMethod);
  if (/^\/v1\/agents\/[^/]+\/channels\/[^/]+\/directory$/.test(pathname))
    return upperMethod === "GET";
  if (pathname === "/v1/env") return upperMethod === "GET";
  if (/^\/v1\/env\/[^/]+$/.test(pathname))
    return upperMethod === "PUT" || upperMethod === "DELETE";

  return (
    /^\/v1\/skills(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/tools(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/hooks(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/workspaces\/[^/]+\/files$/.test(pathname) ||
    /^\/v1\/workspaces(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/sandboxes(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/policies(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/crons(?:\/[^/]+(?:\/runs)?)?$/.test(pathname)
  );
}

export function isWebSocketPath(pathname: string): boolean {
  return matchAgentWebSocketPath(pathname) !== null;
}

/**
 * Parses the two agent WebSocket path shapes so the upgrade can bind the
 * requested endpoint to the runtime key's scope before any stream access.
 */
export function matchAgentWebSocketPath(pathname: string): {
  endpointId: string;
  projectSlug?: string;
  environmentSlug?: string;
} | null {
  const scoped = pathname.match(
    /^\/v1\/([^/]+)\/agents\/([^/]+)\/([^/]+)\/ws$/,
  );
  if (scoped?.[1] && scoped[2] && scoped[3]) {
    return {
      projectSlug: decodeURIComponent(scoped[1]),
      environmentSlug: decodeURIComponent(scoped[2]),
      endpointId: decodeURIComponent(scoped[3]),
    };
  }
  const unscoped = pathname.match(/^\/v1\/agents\/([^/]+)\/ws$/);
  if (unscoped?.[1]) {
    return { endpointId: decodeURIComponent(unscoped[1]) };
  }

  return null;
}

export function isCoreHttpRoute(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/async" ||
    pathname.startsWith("/status/") ||
    pathname === "/accounts" ||
    pathname.startsWith("/accounts/") ||
    pathname.startsWith("/webhooks/") ||
    pathname.startsWith("/async-tools/") ||
    pathname.startsWith("/sandbox-jobs/") ||
    pathname === "/v1" ||
    pathname.startsWith("/v1/")
  );
}
