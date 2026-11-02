/**
 * Side effects that must run before any core module evaluates: the Bun shim,
 * and `redirect: "error"`, which core uses on every outbound call but workerd's
 * fetch does not accept. It becomes "manual" plus a thrown error on a redirect,
 * which is what "error" means.
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
