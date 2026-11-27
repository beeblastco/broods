const observabilityWebSocketPattern =
  /^\/v1\/projects\/([^/]+)\/stages\/([^/]+)\/observability\/ws$/;

export function matchObservabilityWebSocketPath(
  pathname: string,
): RegExpMatchArray | null {
  return pathname.match(observabilityWebSocketPattern);
}

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
