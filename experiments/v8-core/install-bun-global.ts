/**
 * Runs before any core module: installs the Bun shim, and turns `redirect: "error"` (workerd's
 * fetch rejects it) into "manual" plus a thrown error on a redirect.
 */

import "bun";

const nativeFetch = globalThis.fetch;
globalThis.fetch = async function fetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (init?.redirect !== "error") return nativeFetch(input, init);
  const response = await nativeFetch(input, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new TypeError(
      `fetch failed: ${response.status} redirect refused (redirect: "error")`,
    );
  }

  return response;
} as typeof fetch;
