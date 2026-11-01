const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

// Anything not shaped like an id we issue is unvetted client input headed for the logs.
export function resolveRequestId(inbound: string | null | undefined): string {
  return inbound && REQUEST_ID_PATTERN.test(inbound)
    ? inbound
    : crypto.randomUUID();
}

// An id core set must survive back out through Traefik.
export function withRequestId(response: Response, requestId: string): Response {
  if (response.headers.get("x-request-id")) return response;
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers,
  });
}
