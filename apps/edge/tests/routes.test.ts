/**
 * Spot checks of the route table: where the SDK's runtime paths and the config
 * plane's CRUD land. `traefik.test.ts` checks the rendered rules agree.
 */

import { expect, test } from "bun:test";
import { resolveRoute } from "../src/routes.ts";

test("runtime HTTP paths used by the SDK reach core", (): void => {
  expect(upstream("/v1/runs", "POST")).toBe("core");
  expect(upstream("/v1/runs/run_1", "GET")).toBe("core");
  expect(upstream("/v1/accounts", "POST")).toBe("core");
  // The one webhook shape reaches core, and so does a retired agent-scoped URL:
  // core answers that with a 404 naming the right one.
  expect(upstream("/v1/webhooks/acct_1/slack", "POST")).toBe("core");
  expect(upstream("/v1/webhooks/acct_1/agent_1/slack", "POST")).toBe("core");
  expect(
    upstream("/v1/projects/demo/stages/development/agents/env_123", "POST"),
  ).toBe("core");
  expect(upstream("/", "GET")).toBe("gateway");
  expect(upstream("/healthz", "GET")).toBe("gateway");
  expect(upstream("/", "HEAD")).toBeNull();
});

test("core routes only in-cluster callers use are blocked", (): void => {
  expect(upstream("/v1/cron-runs", "POST")).toBe("blocked");
  expect(upstream("/v1/cron-runs/", "POST")).toBe("blocked");
  expect(upstream("/v1/mcp-service/rpc", "POST")).toBe("blocked");
  expect(upstream("/v1/sandboxes/sbx_1/terminate", "POST")).toBe("core");
  expect(upstream("/v1/internal/observability-scope", "POST")).toBe("core");
});

test("a trailing slash keeps a request on its plane", (): void => {
  expect(upstream("/v1/agents/", "GET")).toBe("config");
  expect(upstream("/v1/account/", "DELETE")).toBe("core");
  // An inner empty segment stays in the subtree, as `startsWith` had it.
  expect(upstream("/v1/account//x", "GET")).toBe("config");
  expect(upstream("/v1/webhooks//slack", "POST")).toBe("core");
  expect(upstream("/v1/skills/x//", "PUT")).toBe("config");
});

test("only an upgrade reaches a socket", (): void => {
  expect(resolveRoute("GET", "/v1/agents/a/ws", true)?.upstream).toBe(
    "gateway",
  );
  expect(resolveRoute("GET", "/v1/agents/a/ws", false)?.upstream).toBe("core");
  expect(resolveRoute("GET", "/v1/agents", true)?.upstream).toBe("config");
});

test("routes config-plane CRUD to Convex, not core", () => {
  // Account metadata/rotation plus agents, skills, tools, hooks, workspace files, crons, workspaces, sandboxes, policies, and channels are Convex config-plane routes.
  for (const method of ["GET", "POST", "PUT"]) {
    expect(upstream("/v1/account/onboarding", method)).toBe("config");
    expect(upstream("/v1/account/projects/p/stages/e/manifest", method)).toBe(
      "config",
    );
  }
  expect(upstream("/v1/accountx", "GET")).not.toBe("config");
  expect(upstream("/v1/account", "DELETE")).not.toBe("config");
  expect(upstream("/v1/account", "GET")).toBe("config");
  expect(upstream("/v1/account", "PATCH")).toBe("config");
  expect(upstream("/v1/account/rotate-secret", "POST")).toBe("config");
  expect(upstream("/v1/accounts", "GET")).toBe("config");
  expect(upstream("/v1/accounts/acct_1", "GET")).toBe("config");
  expect(upstream("/v1/accounts/acct_1", "PATCH")).toBe("config");
  expect(upstream("/v1/accounts/acct_1/rotate-secret", "POST")).toBe("config");
  expect(upstream("/v1/agents", "GET")).toBe("config");
  expect(upstream("/v1/agents", "POST")).toBe("config");
  expect(upstream("/v1/agents/agent_1", "GET")).toBe("config");
  expect(upstream("/v1/agents/agent_1", "PATCH")).toBe("config");
  expect(upstream("/v1/agents/agent_1", "DELETE")).toBe("config");
  expect(upstream("/v1/agents/agent_1/channels/slack/directory", "GET")).toBe(
    "config",
  );
  expect(
    upstream("/v1/agents/agent_1/channels/slack/directory", "POST"),
  ).not.toBe("config");
  expect(upstream("/v1/env", "GET")).toBe("config");
  expect(upstream("/v1/env/OVH_API_KEY", "PUT")).toBe("config");
  expect(upstream("/v1/env/OVH_API_KEY", "DELETE")).toBe("config");
  expect(upstream("/v1/skills", "GET")).toBe("config");
  expect(upstream("/v1/skills/my-skill", "GET")).toBe("config");
  // /v1/tools is retired (#331 phase 3); it no longer routes to the config plane.
  expect(upstream("/v1/tools", "GET")).not.toBe("config");
  expect(upstream("/v1/mcp", "GET")).toBe("config");
  expect(upstream("/v1/mcp/k57mcpserver00000000000000000000", "GET")).toBe(
    "config",
  );
  expect(upstream("/v1/mcp/uploads", "POST")).toBe("config");
  expect(upstream("/v1/hooks", "GET")).toBe("config");
  expect(upstream("/v1/hooks/k17zwc4z4q5ysxm74fgrhd13s88xxtv", "GET")).toBe(
    "config",
  );
  expect(upstream("/v1/workspaces", "GET")).toBe("config");
  expect(upstream("/v1/workspaces/ws_123", "GET")).toBe("config");
  expect(upstream("/v1/workspaces/ws_123/files", "GET")).toBe("config");
  expect(upstream("/v1/workspaces/ws_123/download-links", "POST")).toBe(
    "config",
  );
  expect(upstream("/v1/workspaces/ws_123/download-links", "GET")).not.toBe(
    "config",
  );
  // Redeeming a download link is unauthenticated and read-only.
  expect(upstream("/v1/downloads/tok_abc", "GET")).toBe("config");
  expect(upstream("/v1/downloads/tok_abc", "HEAD")).toBe("config");
  expect(upstream("/v1/downloads/tok_abc", "DELETE")).not.toBe("config");
  expect(upstream("/v1/downloads", "GET")).not.toBe("config");
  expect(upstream("/v1/downloads/tok_abc/extra", "GET")).not.toBe("config");
  expect(upstream("/v1/sandboxes", "GET")).toBe("config");
  expect(upstream("/v1/sandboxes/sbx_1", "GET")).toBe("config");
  expect(upstream("/v1/policies", "GET")).toBe("config");
  expect(upstream("/v1/policies/pol_1", "GET")).toBe("config");
  expect(upstream("/v1/roles", "GET")).toBe("config");
  expect(upstream("/v1/roles/fp_role_abc", "GET")).toBe("config");
  expect(upstream("/v1/account/assume-role", "POST")).toBe("config");
  expect(upstream("/v1/channels", "GET")).toBe("config");
  expect(upstream("/v1/channels/chan_1", "GET")).toBe("config");
  expect(upstream("/v1/crons", "GET")).toBe("config");
  expect(upstream("/v1/crons/cron_123", "GET")).toBe("config");
  expect(upstream("/v1/crons/cron_123/runs", "GET")).toBe("config");
  expect(upstream("/v1/cron-runs", "POST")).not.toBe("config");

  // Exact depth only: scoped agent invocations and other resources stay core.
  expect(upstream("/v1/account", "DELETE")).not.toBe("config");
  expect(upstream("/accounts", "POST")).not.toBe("config");
  expect(upstream("/accounts/acct_1", "DELETE")).not.toBe("config");
  expect(upstream("/accounts/acct_1/rotate-secret", "GET")).not.toBe("config");
  expect(upstream("/accounts/acct_1/agents", "GET")).not.toBe("config");
  expect(upstream("/accounts/acct_1/rotate-secret/extra", "POST")).not.toBe(
    "config",
  );
  // The whole /v1/account/ subtree is Convex's; core only owns the exact-path DELETE.
  expect(upstream("/v1/account/rotate-secret", "POST")).toBe("config");
  expect(upstream("/v1/account/auth/exchange", "POST")).toBe("config");
  expect(upstream("/v1/skills/agents/development/env_123", "GET")).not.toBe(
    "config",
  );
  expect(upstream("/v1/hooks/agents/development/env_123", "GET")).not.toBe(
    "config",
  );
  expect(upstream("/v1/crons/agents/development/env_123", "GET")).not.toBe(
    "config",
  );
  expect(upstream("/v1/sandboxes/sbx_1/exec", "GET")).not.toBe("config");
  expect(upstream("/v1/sandboxes/sbx_1/terminal", "GET")).not.toBe("config");
  expect(upstream("/v1/policies/agents/development/env_123", "GET")).not.toBe(
    "config",
  );
  expect(upstream("/v1/channels/agents/development/env_123", "GET")).not.toBe(
    "config",
  );
  expect(upstream("/v1/agents/agent_1", "POST")).not.toBe("config");
  expect(upstream("/v1/env", "PUT")).not.toBe("config");
  expect(upstream("/v1/env/OVH_API_KEY", "GET")).not.toBe("config");
  expect(upstream("/v1/agents/agent_1/ws", "GET")).not.toBe("config");
  expect(upstream("/v1/agents/agent_1/async", "POST")).not.toBe("config");
  expect(upstream("/v1/demo/agents/development/env_123", "POST")).not.toBe(
    "config",
  );
  expect(
    upstream("/v1/demo/agents/development/env_123/async", "POST"),
  ).not.toBe("config");
  expect(upstream("/v1/demo/agents/development/env_123/ws", "GET")).not.toBe(
    "config",
  );
});

function upstream(pathname: string, method: string): string | null {
  return resolveRoute(method, pathname, false)?.upstream ?? null;
}
