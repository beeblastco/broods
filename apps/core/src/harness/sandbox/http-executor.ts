/**
 * The `custom` provider: a server the account runs that speaks the sandbox
 * exec contract (`SandboxExecRequest` in, `SandboxExecResponse` out) on
 * `POST <endpoint>/exec`, the same contract as the lambda-sandbox image.
 * Stateless by design: one run is one request, so there is no reservation,
 * workspace mount, lifecycle or background job here.
 */

import { ACCOUNT_ENV_PLACEHOLDER_PATTERN } from "@broods/convex/model/envRefs";
import type { SandboxExecRequest } from "../../shared/domain/sandbox-config.ts";
import {
  assertPublicHttpsUrl,
  type PinnedFetchTransport,
} from "../../shared/http.ts";
import { guardedFetch } from "../isolate/runner/pinned-fetch.mjs";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import {
  configString,
  EXEC_GRACE_MS,
  execRunResult,
  mergeSandboxEnv,
  parseExecResponse,
  stringRecord,
  truncateText,
} from "./utils.ts";

const PROVIDER = "custom" as const;

/** Test seams: the pinned fetch's injectable options and a shorter client grace. */
export interface HttpSandboxExecutorSeams {
  transport?: PinnedFetchTransport;
  graceMs?: number;
}

export class HttpSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;
  readonly #seams: HttpSandboxExecutorSeams;

  constructor(
    config: SandboxExecutorConfig,
    seams: HttpSandboxExecutorSeams = {},
  ) {
    this.#config = config;
    this.#seams = seams;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const options = this.#config.options ?? {};
    const endpoint = configString(options.endpoint);
    if (!endpoint) {
      throw new Error("custom sandbox needs options.endpoint");
    }
    assertPublicHttpsUrl(endpoint, "custom sandbox endpoint");
    const token = configString(options.token);
    const headers = stringRecord(options.headers);
    // Refs resolve when the sandbox syncs from code. One left over would go out
    // as the credential itself.
    if (
      [token ?? "", ...Object.values(headers)].some((value): boolean =>
        ACCOUNT_ENV_PLACEHOLDER_PATTERN.test(value),
      )
    ) {
      throw new Error(
        "custom sandbox token or header still carries a ${NAME} ref: refs resolve when the sandbox syncs from code, not through the API",
      );
    }
    const payload: SandboxExecRequest = {
      runtime: request.runtime ?? "bash",
      code: request.code,
      timeout_ms: request.timeoutSeconds * 1000,
      ...(request.args && request.args.length > 0
        ? { args: request.args }
        : {}),
      env: mergeSandboxEnv(
        this.#config.envVars,
        request.envVars,
        request.principal,
      ),
    };
    // The address is the boundary: `guardedFetch` refuses every private and
    // metadata address the name resolves to and pins the socket to the one it
    // validated. No redirects, so the token goes to the host named or nowhere.
    const response = await guardedFetch(
      `${endpoint.replace(/\/+$/, "")}/exec`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      },
      {
        ...this.#seams.transport,
        redirectLimit: 0,
        timeoutMs: payload.timeout_ms + (this.#seams.graceMs ?? EXEC_GRACE_MS),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `custom sandbox exec failed (${response.status}): ${truncateText(response.bodyText, request.outputLimitBytes).value}`,
      );
    }

    return execRunResult(
      request,
      parseExecResponse(response.bodyText, "custom sandbox exec"),
      PROVIDER,
      startedAt,
    );
  }
}
