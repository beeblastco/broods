/** Hostnames, `*.` for subdomains: edge CORS and the gateway's socket origin check share it. */
export const DEFAULT_ORIGINS: readonly string[] = [
  "broods.app",
  "*.broods.app",
  "localhost",
  "127.0.0.1",
];
