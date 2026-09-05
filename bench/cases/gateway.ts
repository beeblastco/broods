/**
 * Gateway per-request work. Every public request to Broods lands on these
 * three: classify the path, match the WebSocket shapes, charge the rate limit.
 * They run before any upstream call, so their cost is pure added latency.
 */

import { RateLimiter } from "../../apps/gateway/src/rate-limiter.ts";
import {
  isConfigHttpPath,
  matchAgentWebSocketPath,
  matchObservabilityWebSocketPath,
} from "../../apps/gateway/src/routes.ts";
import type { BenchCase } from "../runner.ts";

// A request mix that exercises both halves of the split: config-plane hits that
// short-circuit early, config-plane hits that fall through to the regex tail,
// and runtime paths that must walk the whole function to return false.
const REQUEST_MIX: ReadonlyArray<{ pathname: string; method: string }> = [
  { pathname: "/v1/account", method: "GET" },
  { pathname: "/v1/agents", method: "POST" },
  { pathname: "/v1/agents/agt_7f3c9d21/", method: "PATCH" },
  { pathname: "/v1/env/OPENAI_API_KEY", method: "PUT" },
  { pathname: "/v1/skills/skill_deploy", method: "GET" },
  { pathname: "/v1/crons/cron_nightly/runs", method: "GET" },
  { pathname: "/v1/workspaces/ws_main/files", method: "GET" },
  { pathname: "/v1/agents/agt_7f3c9d21/invoke", method: "POST" },
  { pathname: "/v1/agents/agt_7f3c9d21/messages", method: "POST" },
  { pathname: "/v1/runs/run_2a91/status", method: "GET" },
  { pathname: "/health", method: "GET" },
  { pathname: "/v1/media/med_8812", method: "GET" },
];

const WEBSOCKET_MIX: readonly string[] = [
  "/v1/agents/agt_7f3c9d21/ws",
  "/v1/acme/production/agents/agt_7f3c9d21/ws",
  "/v1/acme/production/observability/ws",
  "/v1/agents/agt_7f3c9d21/invoke",
];

// Wide enough that the steady-state path is "existing window, still under the
// limit" — the branch a healthy production request actually takes.
const RATE_LIMIT_KEYS: readonly string[] = Array.from(
  { length: 64 },
  (_unused, index) => `203.0.113.${index}:agt_7f3c9d21`,
);

export const gatewayCases: readonly BenchCase[] = [
  {
    name: "gateway/route-classify",
    iterations: 50_000,
    run: (): unknown => {
      const request = REQUEST_MIX[routeCursor++ % REQUEST_MIX.length]!;

      return isConfigHttpPath(request.pathname, request.method);
    },
  },
  {
    name: "gateway/websocket-path-match",
    iterations: 50_000,
    run: (): unknown => {
      const pathname = WEBSOCKET_MIX[socketCursor++ % WEBSOCKET_MIX.length]!;

      return (
        matchAgentWebSocketPath(pathname) ??
        matchObservabilityWebSocketPath(pathname)
      );
    },
  },
  {
    name: "gateway/rate-limiter-allow",
    iterations: 200_000,
    setup: (): void => {
      // A window long enough to never roll over mid-run, and a limit high
      // enough to never trip: this measures the steady-state accept, not the
      // eviction sweep, which is what the overwhelming majority of calls hit.
      limiter = new RateLimiter(Number.MAX_SAFE_INTEGER, 60 * 60 * 1000);
      for (const key of RATE_LIMIT_KEYS) limiter.allow(key);
    },
    run: (): unknown => {
      return limiter.allow(
        RATE_LIMIT_KEYS[limitCursor++ % RATE_LIMIT_KEYS.length]!,
      );
    },
  },
];

let limitCursor = 0;
let limiter = new RateLimiter(Number.MAX_SAFE_INTEGER, 60 * 60 * 1000);
let routeCursor = 0;
let socketCursor = 0;
