/**
 * Test preload (bunfig.toml) that keeps unit tests off the network: any fetch
 * or preconnect that a test has not stubbed and that leaves loopback fails
 * like an unreachable host, so a missing stub can never reach a real provider API.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const realFetch = globalThis.fetch;

globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    assertLoopback(input instanceof Request ? input.url : input);

    return realFetch(input, init);
  },
  {
    preconnect: (...args: Parameters<typeof fetch.preconnect>): void => {
      assertLoopback(args[0]);
      realFetch.preconnect(...args);
    },
  },
);

// Throws for any URL the guarded fetch or preconnect may not open.
function assertLoopback(input: string | URL): void {
  const url = new URL(input);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new TypeError(
      `Unit tests must not reach ${url.host}; stub globalThis.fetch`,
    );
  }
}
