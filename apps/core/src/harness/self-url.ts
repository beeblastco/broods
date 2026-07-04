/**
 * The harness's own public base URL — the gateway front door.
 *
 * Background-job callbacks and async status URLs need an absolute URL to reach
 * this service. The container has a stable public hostname supplied via
 * PUBLIC_BASE_URL; returns undefined when it is unset so callers can degrade to
 * poll-only delivery.
 */

import { optionalEnv } from "../shared/env.ts";

export function getHarnessPublicUrl(): string | undefined {
  const configured = optionalEnv("PUBLIC_BASE_URL");
  return configured ? configured.replace(/\/+$/, "") : undefined;
}
