import type { Suite } from "../suite.ts";

// Each fault changes a decision exercised by a directed Lean vector or token cross-product.
export const suite: Suite = {
  name: "access",
  tests: ["formal/replay/access.test.ts"],
  env: {},
  mutations: [
    {
      name: "gateway origin ignored",
      file: "apps/gateway/src/main.ts",
      find: '!isOriginAllowed(request.headers.get("origin"), config.allowedOrigins)',
      replace: "false",
    },
    {
      name: "gateway capacity ignores pending limit",
      file: "apps/gateway/src/main.ts",
      find: "sockets.size + pendingUpgrades >= config.limits.maxConnections",
      replace: "false",
    },
    {
      name: "agent endpoint scope ignored",
      file: "apps/gateway/src/main.ts",
      find: "!scope.endpointIds.includes(agentWebSocketPath.endpointId)",
      replace: "false",
    },
    {
      name: "observability accepts no expiry",
      file: "apps/gateway/src/main.ts",
      find: "expiresAt === undefined || !Number.isFinite(expiresAt)",
      replace: "false",
    },
    {
      name: "principal requester lost",
      file: "apps/core/src/shared/domain/principal.ts",
      find: "...principal.chain,",
      replace: "",
    },
    {
      name: "rate window rolls over late",
      file: "apps/gateway/src/rate-limiter.ts",
      find: "now - window.start >= this.#windowMs",
      replace: "now - window.start > this.#windowMs",
    },
    {
      name: "reserved event prefix accepted",
      file: "apps/core/src/shared/runtime-keys.ts",
      find: "if (hasReservedEventIdPrefix(normalized)) {",
      replace: "if (false) {",
    },
    {
      name: "role ttl default too long",
      file: "packages/convex/model/roleRules.ts",
      find: "input.ttlSeconds ?? ROLE_SESSION_DEFAULT_TTL_SECONDS",
      replace: "input.ttlSeconds ?? ROLE_SESSION_MAX_TTL_SECONDS",
    },
    {
      name: "last edge match wins",
      file: "apps/edge/src/routes.ts",
      find: "ROUTERS.find((router)",
      replace: "[...ROUTERS].reverse().find((router)",
    },
    {
      name: "download path logged",
      file: "apps/edge/src/routes.ts",
      find: "secretPath: true,\n    rules: [{ path: `/v1/downloads/",
      replace: "secretPath: undefined,\n    rules: [{ path: `/v1/downloads/",
    },
    {
      name: "service token accepted through gateway",
      file: "apps/core/src/shared/auth.ts",
      find: "if (headers[VIA_GATEWAY_HEADER] !== undefined) return false;",
      replace: "",
    },
    {
      name: "disabled run account accepted",
      file: "apps/core/src/shared/auth.ts",
      find: 'if (!account || account.status !== "active") return null;',
      replace: "if (!account) return null;",
    },
    {
      name: "runtime user token ignored",
      file: "apps/core/src/shared/auth.ts",
      find: "if (userTokenHeader !== undefined) {",
      replace: "if (false) {",
    },
    {
      name: "API deny ignored",
      file: "packages/convex/model/apiAuthorization.ts",
      find: 'if (rule.effect === "deny") {',
      replace: "if (false) {",
    },
    {
      name: "role project pin ignored",
      file: "packages/convex/model/apiAuthorization.ts",
      find: "principal.projectId !== resource.projectId",
      replace: "false",
    },
    {
      name: "resource id selector ignored",
      file: "packages/convex/model/apiAuthorization.ts",
      find: "return resource.id !== undefined && resourceIds.includes(resource.id);",
      replace: "return true;",
    },
    {
      name: "expired run accepted",
      file: "apps/core/src/shared/run-token.ts",
      find: "claims.exp <= now",
      replace: "false",
    },
    {
      name: "expired terminal accepted",
      file: "apps/core/src/shared/terminal-ticket.ts",
      find: "sealed.data.expiresAt <= now",
      replace: "false",
    },
    {
      name: "expired media accepted",
      file: "apps/core/src/shared/media-ticket.ts",
      find: "parsed.data.exp * 1000 > now",
      replace: "true",
    },
    {
      name: "expired stage accepted",
      file: "packages/convex/model/stageSessionTicket.ts",
      find: "ticket.expiresAt <= now",
      replace: "false",
    },
    {
      name: "status deployment scope ignored",
      file: "apps/core/src/harness/status-access.ts",
      find: "deployment?.accountId === auth.account.accountId",
      replace: "true",
    },
    {
      name: "stage ticket cannot read private status",
      file: "apps/core/src/harness/status-access.ts",
      find: "agent.config.publicAccess !== true && !auth.stageTicket",
      replace: "agent.config.publicAccess !== true",
    },
    {
      name: "status user requirement ignored",
      file: "apps/core/src/harness/status-access.ts",
      find: "agent.requireUserToken === true && !auth.user",
      replace: "false",
    },
  ],
};
