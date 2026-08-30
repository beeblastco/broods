/**
 * Types for `pinned-fetch.mjs`, which stays plain JS because the runner ships
 * it into isolates. This file is the one home of the helper's contract — TS
 * cannot check it against the implementation, so a change to either file means
 * changing both.
 */

import type { LookupAddress } from "node:dns";
import type { ClientRequestArgs } from "node:http";

export declare const BODY_LIMIT_BYTES: number;
export declare const DENY_CIDRS: string[];
export declare const FETCH_TIMEOUT_MS: number;
export declare const REDIRECT_LIMIT: number;

export interface GuardedFetchInit {
  body?: string | Uint8Array | ArrayBuffer | ArrayBufferView;
  headers?: Headers | [string, string][] | Record<string, string | undefined>;
  method?: string;
}

/**
 * `allowAddresses`, `ca`, `createConnection`, and `lookup` are test seams:
 * production callers leave them unset so the socket really opens to the
 * validated address and TLS verifies against the system roots.
 * `allowAddresses` exempts exact addresses (the test loopback) from the
 * denylist and deliberately cannot replace the check itself.
 */
export interface GuardedFetchOptions {
  allowAddresses?: string[];
  bodyLimitBytes?: number;
  ca?: string;
  /** 0 refuses redirects; omitted means REDIRECT_LIMIT. */
  redirectLimit?: number;
  createConnection?: ClientRequestArgs["createConnection"];
  lookup?: (
    hostname: string,
    options: { all: boolean; verbatim: boolean },
  ) => Promise<LookupAddress[]>;
  timeoutMs?: number;
}

export interface GuardedFetchBinaryResponse {
  /** Empty for a non-2xx answer: binary mode never downloads an error body. */
  bodyBytes: Uint8Array;
  headers: Record<string, string>;
  status: number;
}

export interface GuardedFetchTextResponse {
  bodyText: string;
  headers: Record<string, string>;
  status: number;
}

export declare function guardedFetch(
  url: string | URL,
  init: GuardedFetchInit | undefined,
  opts: GuardedFetchOptions & { binary: true },
): Promise<GuardedFetchBinaryResponse>;
export declare function guardedFetch(
  url: string | URL,
  init?: GuardedFetchInit,
  opts?: GuardedFetchOptions & { binary?: false },
): Promise<GuardedFetchTextResponse>;

export declare function isDeniedAddress(address: string): boolean;
