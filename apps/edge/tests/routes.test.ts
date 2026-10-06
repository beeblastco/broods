/**
 * Spot checks of the route table: where the SDK's runtime paths, the sockets
 * and the config plane's CRUD land. `traefik.test.ts` checks the rendered
 * rules agree with the table.
 */

import { expect, test } from "bun:test";
import { resolveRouter, type Upstream } from "../src/routes.ts";

// [method, path, upstream]; null is a 404 at the edge.
const CASES: [string, string, Upstream | null][] = [
  ["GET", "/", "gateway"],
  ["GET", "/healthz", "gateway"],
  ["HEAD", "/", null],
  ["GET", "/v2/agents", null],

  // Runtime paths the SDK calls.
  ["POST", "/v1/runs", "core"],
  ["GET", "/v1/runs/run_1", "core"],
  ["POST", "/v1/accounts", "core"],
  ["POST", "/v1/projects/demo/stages/development/agents/env_123", "core"],
  ["POST", "/v1/agents/agent_1/async", "core"],
  ["POST", "/v1/sandboxes/sbx_1/terminate", "core"],
  ["POST", "/v1/internal/observability-scope", "core"],
  // Channel webhooks, including a retired agent-scoped URL core answers itself.
  ["POST", "/v1/webhooks/acct_1/slack", "core"],
  ["POST", "/v1/webhooks/acct_1/agent_1/slack", "core"],
  // In-cluster only: core refuses them without the service token.
  ["POST", "/v1/cron-runs", "core"],
  ["POST", "/v1/mcp-service/rpc", "core"],

  // Sockets go to the gateway by path, upgrade or not.
  ["GET", "/v1/agents/a/ws", "gateway"],
  ["GET", "/v1/projects/p/stages/s/agents/a/ws", "gateway"],
  ["GET", "/v1/projects/p/stages/s/observability/ws", "gateway"],
  ["GET", "/v1/sandboxes/terminal/ws", "gateway"],
  ["GET", "/v1/machines/ws", "gateway"],
  ["GET", "/v1/demo/agents/development/env_123/ws", "core"],

  // The config plane, method by method; a method miss falls through to core.
  ["GET", "/v1/account", "config"],
  ["PATCH", "/v1/account", "config"],
  ["DELETE", "/v1/account", "core"],
  ["GET", "/v1/accountx", "core"],
  ["POST", "/v1/account/assume-role", "config"],
  ["POST", "/v1/account/auth/exchange", "config"],
  ["PUT", "/v1/account/projects/p/stages/e/manifest", "config"],
  ["GET", "/v1/accounts", "config"],
  ["GET", "/v1/accounts/acct_1", "config"],
  ["PATCH", "/v1/accounts/acct_1", "config"],
  ["POST", "/v1/accounts/acct_1/rotate-secret", "config"],
  ["GET", "/v1/agents", "config"],
  ["POST", "/v1/agents", "config"],
  ["DELETE", "/v1/agents/agent_1", "config"],
  ["POST", "/v1/agents/agent_1", "core"],
  ["GET", "/v1/agents/agent_1/channels/slack/directory", "config"],
  ["POST", "/v1/agents/agent_1/channels/slack/directory", "core"],
  ["GET", "/v1/env", "config"],
  ["PUT", "/v1/env", "core"],
  ["PUT", "/v1/env/OVH_API_KEY", "config"],
  ["GET", "/v1/env/OVH_API_KEY", "core"],
  ["GET", "/v1/skills/my-skill", "config"],
  ["GET", "/v1/skills/agents/development/env_123", "core"],
  ["POST", "/v1/mcp/uploads", "config"],
  ["GET", "/v1/hooks/k17zwc4z4q5ysxm74fgrhd13s88xxtv", "config"],
  ["GET", "/v1/workspaces/ws_123", "config"],
  ["GET", "/v1/workspaces/ws_123/files", "config"],
  ["POST", "/v1/workspaces/ws_123/download-links", "config"],
  ["GET", "/v1/workspaces/ws_123/download-links", "core"],
  ["GET", "/v1/downloads/tok_abc", "config"],
  ["HEAD", "/v1/downloads/tok_abc", "config"],
  ["DELETE", "/v1/downloads/tok_abc", "core"],
  ["GET", "/v1/downloads/tok_abc/extra", "core"],
  ["GET", "/v1/sandboxes/sbx_1", "config"],
  ["GET", "/v1/sandboxes/sbx_1/exec", "core"],
  ["GET", "/v1/policies/pol_1", "config"],
  ["GET", "/v1/roles/fp_role_abc", "config"],
  ["GET", "/v1/channels/chan_1", "config"],
  ["GET", "/v1/crons/cron_123/runs", "config"],

  // Trailing slashes never move a request; an inner empty segment stays in
  // its subtree.
  ["GET", "/v1/agents/", "config"],
  ["DELETE", "/v1/account/", "core"],
  ["POST", "/v1/cron-runs/", "core"],
  ["GET", "/v1/account//x", "config"],
  ["POST", "/v1/webhooks//slack", "core"],
  ["PUT", "/v1/skills/x//", "config"],
];

test("each request reaches its upstream", (): void => {
  for (const [method, path, upstream] of CASES) {
    expect(
      `${method} ${path} → ${resolveRouter(method, path)?.upstream ?? null}`,
    ).toBe(`${method} ${path} → ${upstream}`);
  }
});
