/**
 * Browser origins allowed to call the API, as hostnames; `*.` matches
 * subdomains. The edge's CORS and the gateway's WebSocket origin check both
 * default to this list, so HTTP and sockets agree.
 */
export const DEFAULT_ORIGINS: readonly string[] = [
  "broods.app",
  "*.broods.app",
  "localhost",
  "127.0.0.1",
];
