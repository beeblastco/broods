/**
 * The socket paths the gateway serves. Which requests reach the gateway at all
 * is the edge route table's call (`apps/edge/src/routes.ts`); these parse the
 * ids an upgrade binds its credential to.
 */

const observabilityWebSocketPattern =
  /^\/v1\/projects\/([^/]+)\/stages\/([^/]+)\/observability\/ws$/;

export function matchObservabilityWebSocketPath(
  pathname: string,
): RegExpMatchArray | null {
  return pathname.match(observabilityWebSocketPattern);
}

/**
 * Parses the two agent WebSocket path shapes so the upgrade can bind the
 * requested endpoint to the runtime key's scope before any stream access.
 */
export function matchAgentWebSocketPath(pathname: string): {
  endpointId: string;
  projectSlug?: string;
  stageSlug?: string;
} | null {
  const scoped = pathname.match(
    /^\/v1\/projects\/([^/]+)\/stages\/([^/]+)\/agents\/([^/]+)\/ws$/,
  );
  if (scoped?.[1] && scoped[2] && scoped[3]) {
    return {
      projectSlug: decodeURIComponent(scoped[1]),
      stageSlug: decodeURIComponent(scoped[2]),
      endpointId: decodeURIComponent(scoped[3]),
    };
  }
  const unscoped = pathname.match(/^\/v1\/agents\/([^/]+)\/ws$/);
  if (unscoped?.[1]) {
    return { endpointId: decodeURIComponent(unscoped[1]) };
  }

  return null;
}
