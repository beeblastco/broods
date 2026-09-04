/**
 * Core's own front door: the two things `Bun.serve` does to every request
 * before any handler sees it. Route the path to the account or harness
 * handler, and lower the Web Request into the transport-neutral CoreRequest
 * the handlers consume, headers lowered and body read.
 */

import {
  routesToAccountManage,
  toCoreRequest,
} from "../../apps/core/src/server.ts";
import type { BenchCase } from "../runner.ts";

const REQUEST_MIX: ReadonlyArray<{ method: string; pathname: string }> = [
  { method: "POST", pathname: "/v1/agents/agt_7f3c9d21" },
  { method: "POST", pathname: "/v1/acme/production/agents/agt_7f3c9d21" },
  { method: "GET", pathname: "/v1/runs/run_2a91/status" },
  { method: "POST", pathname: "/webhooks/acc_5f21c9/slack" },
  { method: "POST", pathname: "/v1/sandboxes/sbx_11/exec" },
  { method: "DELETE", pathname: "/accounts/acc_5f21c9" },
  { method: "POST", pathname: "/v1/mcp-service/rpc" },
  { method: "POST", pathname: "/v1/cron-runs" },
];

// A direct agent invocation as the gateway forwards it: a bearer key, the
// forwarding chain the ingress appends, and a JSON body of realistic size.
const INVOKE_URL = new URL(
  "http://core.internal/v1/agents/agt_7f3c9d21?stream=1",
);
const INVOKE_BODY = JSON.stringify({
  conversationKey: "api:conv_9c41",
  mode: "followup",
  messages: [
    {
      role: "user",
      content:
        "Summarize the last three deployments for the payments service and flag any that rolled back.",
    },
  ],
});
const INVOKE_HEADERS: Readonly<Record<string, string>> = {
  authorization: "Bearer fp_agent_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p",
  "content-type": "application/json",
  "x-forwarded-for": "198.51.100.7, 10.0.4.21",
  "x-request-id": "req_01J8ZQ4Y2K",
  cookie: "broods_session=abc123; theme=dark",
  "user-agent": "broods-sdk/0.32.0",
};

export const coreServerCases: readonly BenchCase[] = [
  {
    name: "core/server-route-request",
    iterations: 50_000,
    run: (): unknown => {
      const request = REQUEST_MIX[routeCursor++ % REQUEST_MIX.length]!;

      return routesToAccountManage(request.method, request.pathname);
    },
  },
  {
    name: "core/server-lower-request",
    iterations: 5_000,
    run: (): Promise<unknown> => {
      return toCoreRequest(
        new Request(INVOKE_URL.href, {
          method: "POST",
          headers: { ...INVOKE_HEADERS },
          body: INVOKE_BODY,
        }),
        INVOKE_URL,
        "10.0.4.21",
      );
    },
  },
];

let routeCursor = 0;
