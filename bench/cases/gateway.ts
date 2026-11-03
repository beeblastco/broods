import { RateLimiter } from "../../apps/gateway/src/rate-limiter.ts";
import {
  matchAgentWebSocketPath,
  matchObservabilityWebSocketPath,
} from "../../apps/gateway/src/routes.ts";
import type { BenchCase } from "../runner.ts";

const WEBSOCKET_MIX: readonly string[] = [
  "/v1/agents/agt_7f3c9d21/ws",
  "/v1/projects/acme/stages/production/agents/agt_7f3c9d21/ws",
  "/v1/projects/acme/stages/production/observability/ws",
  "/v1/agents/agt_7f3c9d21/invoke",
];

const RATE_LIMIT_KEYS: readonly string[] = Array.from(
  { length: 64 },
  (_unused, index) => `203.0.113.${index}:agt_7f3c9d21`,
);

export const gatewayCases: readonly BenchCase[] = [
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
      // Never rolls over or trips: the steady-state accept most calls hit, not the eviction.
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
let socketCursor = 0;
