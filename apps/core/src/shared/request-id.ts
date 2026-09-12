/**
 * The `X-Request-Id` both hops share. The gateway resolves one per inbound
 * request and forwards it; core reuses that value so one client request keeps a
 * single id through the logs of both services.
 */

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Reuse an inbound id only when it looks like one we issued. Anything else is
 * unvetted client input headed for the log pipeline.
 */
export function resolveRequestId(inbound: string | null | undefined): string {
  return inbound && REQUEST_ID_PATTERN.test(inbound)
    ? inbound
    : crypto.randomUUID();
}

/**
 * Add the id unless the response already carries one, so an id core set
 * survives back out through the gateway. Streaming responses keep their body;
 * only the header set is rebuilt.
 */
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
