// pinned-fetch.mjs stays plain JS for the Node runner, and TS cannot check it: change both files.

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

// allowAddresses, ca, createConnection and lookup are test seams; production leaves them unset.
export interface GuardedFetchOptions {
  allowAddresses?: string[];
  bodyLimitBytes?: number;
  ca?: string;
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
