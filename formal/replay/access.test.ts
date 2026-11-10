import { expect, test, mock } from "bun:test";
import { spawnSync } from "node:child_process";

// Install before imports: accidental cloud access must fail immediately.
globalThis.fetch = Object.assign(
  (): Promise<Response> => {
    throw new Error("unstubbed fetch");
  },
  { preconnect: (): void => {} },
);
const { resolveRouter } = await import("../../apps/edge/src/routes.ts");
const { authorize } =
  await import("../../packages/convex/model/apiAuthorization.ts");
const { normalizeAssumeRoleInput } =
  await import("../../packages/convex/model/roleRules.ts");
const { statusAccessDenial } =
  await import("../../apps/core/src/harness/status-access.ts");
const { sealRunToken, openRunToken } =
  await import("../../apps/core/src/shared/run-token.ts");
const { sealTerminalTicket, openTerminalTicket } =
  await import("../../apps/core/src/shared/terminal-ticket.ts");
const { sealMediaTicket, openMediaTicket } =
  await import("../../apps/core/src/shared/media-ticket.ts");
const { sealStageSessionTicket, openStageSessionTicket } =
  await import("../../packages/convex/model/stageSessionTicket.ts");
const { sealUserToken, openUserToken } =
  await import("../../packages/convex/model/userToken.ts");
const { sealObservabilityTicket, openObservabilityTicket } =
  await import("../../packages/convex/model/observabilityTicket.ts");

type Vector =
  | { kind: "secretName"; name: string; secret: boolean }
  | { kind: "child"; fault: number; result: number }
  | { kind: "identifier"; value: string; event: boolean; valid: boolean }
  | { kind: "key"; value: string; parsed: string[] | null; public: string }
  | {
      kind: "principal";
      n: number;
      chain: string[] | null;
      delegated: string[] | null;
    }
  | {
      kind: "limiter";
      retry: number;
      now: number;
      count: number;
      blocked: boolean;
      allow: boolean;
    }
  | { kind: "upgrade"; route: number; bits: number; result: number }
  | {
      kind: "auth";
      index: number;
      bits: number;
      result: string | null;
      account: number | null;
    }
  | {
      kind: "credentialKind";
      index: number;
      prefix: string;
      bits: number;
      result: string | null;
      service: boolean;
    }
  | {
      kind: "ticket";
      source: number;
      target: number;
      at: number;
      accepted: boolean;
    }
  | {
      kind: "route";
      method: string;
      path: string;
      route: string | null;
      secret: boolean;
    }
  | { kind: "api"; n: number; m: number; allow: boolean }
  | {
      kind: "status";
      required: boolean;
      present: boolean;
      public: boolean;
      ticket: boolean;
      scope: boolean;
      owns: boolean;
      result: number;
    };

const result = spawnSync(
  `${import.meta.dir}/../.lake/build/bin/spec-replay`,
  ["access"],
  {
    cwd: `${import.meta.dir}/..`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);
if (result.status !== 0) throw new Error(result.stdout + result.stderr);
const vectors = result.stdout
  .trim()
  .split("\n")
  .map((s): Vector => JSON.parse(s) as Vector);

test.each(vectors.map((vector, index) => [index, vector] as const))(
  "access vector %i",
  async (_index, vector): Promise<void> => {
    if (vector.kind === "secretName") {
      expect(isSecretName(vector.name)).toBe(vector.secret);
    } else if (vector.kind === "child") {
      await replayChild(vector);
    } else if (vector.kind === "identifier") {
      const validate = vector.event
        ? runtimeKeys.assertValidPublicEventId
        : runtimeKeys.assertValidPublicConversationKey;
      if (vector.valid)
        expect(validate(vector.value)).toBe(vector.value.trim());
      else expect(() => validate(vector.value)).toThrow();
    } else if (vector.kind === "key") {
      const parsed = runtimeKeys.parseAccountAgentScopedKey(vector.value);
      expect(
        parsed ? [parsed.accountId, parsed.agentId, parsed.key] : null,
      ).toEqual(vector.parsed);
      expect(
        runtimeKeys.publicConversationKeyFromScoped(vector.value, "a", "g"),
      ).toBe(vector.public);
    } else if (vector.kind === "principal") {
      const n = vector.n;
      const chain = directPrincipalChain({
        ...(n % 2 === 1
          ? { principalChain: [{ kind: "user" as const, id: "u" }] }
          : {}),
        cronRun: n % 4 >= 2,
        ...(n >= 4
          ? {
              replyTarget: {
                channelName: "channel",
                identity: { userId: "channel-user" },
              },
            }
          : {}),
      });
      const principal = {
        kind: "agent" as const,
        accountId: "7",
        agentId: "g",
        chain: chain,
      };
      const labels = principalChainLabel(principal);
      expect(labels?.split(">") ?? null).toEqual(vector.delegated);
      expect(
        chain?.map((link) =>
          link.kind === "user"
            ? `user:${link.id}`
            : link.kind === "api"
              ? `api:${link.keyKind}`
              : `agent:${link.agentId}`,
        ) ?? null,
      ).toEqual(vector.chain);
    } else if (vector.kind === "limiter") {
      const originalNow = Date.now;
      let now = 0;
      Date.now = (): number => now;
      try {
        const limiter = new RateLimiter(2, 60000);
        for (let i = 0; i < vector.count; i += 1) limiter.allow("ip");
        now = vector.now;
        expect(limiter.blocked("ip")).toBe(vector.blocked);
        expect(limiter.retryAfterSeconds("ip")).toBe(vector.retry);
        expect(limiter.allow("ip")).toBe(vector.allow);
      } finally {
        Date.now = originalNow;
      }
    } else if (vector.kind === "upgrade") {
      await replayUpgrade(vector);
    } else if (vector.kind === "auth") {
      await replayAuth(vector);
    } else if (vector.kind === "credentialKind") {
      await replayCredentialKind(vector);
    } else if (vector.kind === "ticket") {
      expect(
        (await openers[vector.target]!(tokens[vector.source]!, vector.at)) !==
          null,
      ).toBe(vector.accepted);
    } else if (vector.kind === "route") {
      const actual = resolveRouter(vector.method, vector.path);
      expect({
        route: actual?.name ?? null,
        secret: actual?.secretPath === true,
      }).toEqual({ route: vector.route, secret: vector.secret });
    } else if (vector.kind === "api") {
      const { n, m } = vector;
      const actual = authorize(
        {
          kind: "role",
          accountId: "a",
          roleId: "r",
          ...(m >= 4 ? { projectId: "p" } : {}),
          policy: {
            version: 1,
            rules: [
              {
                id: "r",
                effect: n % 2 === 1 ? "deny" : "allow",
                actions: n % 4 >= 2 ? ["agents:read"] : [],
                ...(n >= 4 ? { resources: { resourceIds: ["x"] } } : {}),
              },
            ],
          },
        },
        "agents:read",
        {
          type: "agents",
          ...(m % 2 === 1 ? { id: "x" } : {}),
          ...(m % 4 >= 2 ? { projectId: "p" } : {}),
        },
      );
      expect(actual.allow).toBe(vector.allow);
    } else {
      const scope = {
        accountId: "a",
        endpointId: "e",
        projectSlug: "p",
        stageSlug: "s",
      };
      const auth = {
        account: { accountId: "a" },
        ...scope,
        ...(vector.ticket
          ? {
              stageTicket: {
                projectId: "p",
                stageId: "s",
                sandboxWrite: false,
                expiresAt: 100,
              },
            }
          : {}),
        ...(vector.present ? { user: { userId: "u", expiresAt: 100 } } : {}),
      };
      // These records are inputs to the real access function; unrelated storage fields are unused.
      type Context = Parameters<typeof statusAccessDenial>[2];
      const context: Context = {
        agentLoader: async () =>
          ({
            agentId: "agent",
            config: { publicAccess: vector.public },
            requireUserToken: vector.required,
          }) as Awaited<ReturnType<Context["agentLoader"]>>,
        deploymentLoader: async () =>
          vector.scope ? scope : { ...scope, accountId: "other" },
        asyncAgentResultLoader: async () => null,
        ingressStatusByEventIdLoader: async () => null,
      };
      const conversationKey = vector.present
        ? vector.owns
          ? "bsu:u:key"
          : "bsu:other:key"
        : vector.owns
          ? "key"
          : "bsu:u:key";
      const ingress = {
        conversationKey: `acct:a:agent:agent:api:${conversationKey}`,
        publicDeploymentIngress: scope,
      } as Parameters<typeof statusAccessDenial>[1]["ingress"];
      const actual = await statusAccessDenial(
        auth,
        {
          accountId: "a",
          agentId: "agent",
          eventId: "ev",
          publicEventId: "ev",
          ingress: ingress,
        },
        context,
      );
      expect(actual?.code ?? null).toBe(
        [
          null,
          "public_access_disabled",
          "status_access_denied",
          "user_token_required",
        ][vector.result],
      );
    }
  },
);

process.env.STAGE_TICKET_SECRET = "symbolic-test-secret";
const now = 100000;
const secret = "symbolic-test-secret";
const run = sealRunToken({ accountId: "a", agentId: "g" }, now, 1000);
const terminal = sealTerminalTicket(
  {
    accountId: "a",
    url: "wss://invalid.test",
    authorization: "Bearer x",
    expiresAt: now + 1000,
  },
  secret,
);
process.env.MEDIA_TICKET_TTL_SECONDS = "2592000";
const media = sealMediaTicket({ accountId: "a", path: "p" }, secret, now);
const stage = await sealStageSessionTicket(
  {
    accountId: "a",
    endpointId: "e",
    projectId: "p",
    projectSlug: "p",
    stageId: "s",
    stageSlug: "s",
    expiresAt: now + 1000,
  },
  secret,
);
const user = await sealUserToken(
  { userId: "u", expiresAt: now + 1000 },
  "bsig_test",
  now,
);
const observability = await sealObservabilityTicket(
  {
    accountId: "a",
    endpointId: "e",
    projectSlug: "p",
    stageSlug: "s",
    expiresAt: now + 1000,
  },
  secret,
);
const tokens = [run, terminal, media, stage, user, observability];
const openers = [
  (s: string, at: number) => openRunToken(s, at),
  (s: string, at: number) => openTerminalTicket(s, secret, at),
  (s: string, at: number) => openMediaTicket(s, ["wrong", secret], at),
  (s: string, at: number) => openStageSessionTicket(s, secret, at),
  (s: string, at: number) => openUserToken(s, "bsig_test", at),
  (s: string, at: number) => openObservabilityTicket(s, secret, at),
];
test.each([undefined, 0, 1, 3600, 43200, 43201, -1, 1.5])(
  "role ttl %s",
  (ttl): void => {
    if (
      ttl !== undefined &&
      (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 43200)
    ) {
      expect(() =>
        normalizeAssumeRoleInput({ roleId: " r ", ttlSeconds: ttl }),
      ).toThrow();
    } else {
      expect(
        normalizeAssumeRoleInput({ roleId: " r ", ttlSeconds: ttl }),
      ).toEqual({ roleId: "r", ttlSeconds: ttl ?? 3600 });
    }
  },
);

const authState = { active: true, valid: true, scoped: false };
const accountRow = (): { accountId: string; status: string } => ({
  accountId: "7",
  status: authState.active ? "active" : "disabled",
});
void mock.module("../../apps/core/src/shared/storage.ts", () => ({
  getStorage: () => ({
    accounts: {
      getById: async () => (authState.valid ? accountRow() : null),
      getBySecretHash: async () =>
        authState.valid && !authState.scoped ? accountRow() : null,
    },
    accountApiKeys: {
      resolveByKeyHash: async () =>
        authState.valid && authState.scoped
          ? {
              account: accountRow(),
              principal: { accountId: "7", roleId: "r" },
              stampDue: false,
            }
          : null,
    },
    roleSessions: {
      resolveByTokenHash: async () =>
        authState.valid ? { accountId: "7", roleId: "r" } : null,
    },
    agentDeployments: {
      getByApiKeyHash: async () =>
        authState.valid
          ? {
              accountId: "7",
              account: accountRow(),
              endpointId: "e",
              projectSlug: "p",
              stageSlug: "s",
              userTokenSecret: "cipher",
            }
          : null,
      touchLastUsed: async () => {},
    },
  }),
}));
void mock.module("../../apps/core/src/shared/convex/account-keys.ts", () => ({
  decryptAccountBlob: async () => ({ value: "bsig_test" }),
}));
const { resolveBearerAuth, isServiceToken } =
  await import("../../apps/core/src/shared/auth.ts");
const signedUser = await sealUserToken(
  { userId: "u", expiresAt: Date.now() + 600000 },
  "bsig_test",
);
process.env.ADMIN_ACCOUNT_SECRET = "admin-test";
process.env.SERVICE_AUTH_SECRET = "service-test";
const signedStage = await sealStageSessionTicket(
  {
    accountId: "7",
    endpointId: "e",
    projectId: "p",
    projectSlug: "p",
    stageId: "s",
    stageSlug: "s",
    expiresAt: Date.now() + 600000,
  },
  secret,
);
const signedRun = sealRunToken({ accountId: "7", agentId: "g" });
const credentialTokens = [
  "bsts_test",
  signedStage,
  signedRun,
  "admin-test",
  "service-test",
  "bask_test",
  "bsk_test",
  user,
  terminal,
  media,
  "unknown",
  "bask_scoped",
  observability,
];

async function replayAuth(v: Extract<Vector, { kind: "auth" }>): Promise<void> {
  const flag = (n: number): boolean => Math.floor(v.bits / 2 ** n) % 2 === 1;
  authState.scoped = v.index === 11;
  authState.valid = flag(0);
  authState.active = flag(1);
  const token = flag(0)
    ? credentialTokens[v.index]!
    : `invalid-${credentialTokens[v.index]}`;
  const actual = await resolveBearerAuth(
    {
      authorization: `Bearer ${token}`,
      "x-account-id": "7",
      ...(flag(2) ? { "x-broods-via-gateway": "" } : {}),
      ...(flag(4)
        ? { "x-broods-user-token": flag(5) ? signedUser : "bad" }
        : {}),
    },
    { allowDisabledAccountSecret: flag(3) },
  );
  expect({
    kind: actual?.kind ?? null,
    account:
      actual && actual.kind !== "admin"
        ? Number(actual.account.accountId)
        : null,
  }).toEqual({ kind: v.result, account: v.account });
}

// The admin and service secrets are set to the token itself when the vector says it matches.
async function replayCredentialKind(
  v: Extract<Vector, { kind: "credentialKind" }>,
): Promise<void> {
  const flag = (n: number): boolean => Math.floor(v.bits / 2 ** n) % 2 === 1;
  const token = credentialTokens[v.index]!;
  if (v.prefix.includes("_")) {
    expect(token.startsWith(v.prefix.slice(0, v.prefix.indexOf("_") + 1))).toBe(
      true,
    );
  }
  authState.scoped = false;
  authState.valid = true;
  authState.active = true;
  process.env.ADMIN_ACCOUNT_SECRET = flag(0) ? token : "admin-test";
  process.env.SERVICE_AUTH_SECRET = flag(1) ? token : "service-test";
  try {
    const actual = await resolveBearerAuth({
      authorization: `Bearer ${token}`,
      "x-account-id": "7",
      ...(flag(2) ? { "x-broods-via-gateway": "" } : {}),
    });
    expect({
      result: actual?.kind ?? null,
      service: actual?.kind === "account" && actual.viaServiceToken === true,
    }).toEqual({ result: v.result, service: v.service });
  } finally {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-test";
    process.env.SERVICE_AUTH_SECRET = "service-test";
  }
}

test("service marker presence refuses even an empty marker", (): void => {
  expect(isServiceToken({ "x-broods-via-gateway": "" }, "service-test")).toBe(
    false,
  );
});

const { createGateway } = await import("../../apps/gateway/src/main.ts");
const { RateLimiter } = await import("../../apps/gateway/src/rate-limiter.ts");
const { gatewayLimitsFromEnv } =
  await import("../../apps/gateway/src/utils.ts");
const { directPrincipalChain, delegatedChain, principalChainLabel } =
  await import("../../apps/core/src/shared/domain/principal.ts");

test("principal requester retained through delegation", (): void => {
  const chain = directPrincipalChain({
    principalChain: [{ kind: "user", id: "u" }],
    cronRun: true,
  });
  const p = {
    kind: "agent" as const,
    accountId: "7",
    agentId: "g",
    chain: chain,
  };
  expect(delegatedChain(p)).toEqual([
    { kind: "user", id: "u" },
    { kind: "agent", agentId: "g" },
  ]);
  expect(principalChainLabel(p)).toBe("user:u>agent:g");
  expect(
    delegatedChain({ kind: "agent", accountId: "7", agentId: "g" }),
  ).toBeUndefined();
  expect(directPrincipalChain({ cronRun: true })).toEqual([
    { kind: "api", keyKind: "cron" },
  ]);
});

test("deny overrides preceding allow", (): void => {
  expect(
    authorize(
      {
        kind: "role",
        accountId: "7",
        roleId: "r",
        policy: {
          version: 1,
          rules: [
            { id: "a", effect: "allow", actions: ["agents:read"] },
            { id: "d", effect: "deny", actions: ["agents:read"] },
          ],
        },
      },
      "agents:read",
      { type: "agents" },
    ).allow,
  ).toBe(false);
});

async function replayUpgrade(
  v: Extract<Vector, { kind: "upgrade" }>,
): Promise<void> {
  const flag = (n: number): boolean => Math.floor(v.bits / 2 ** n) % 2 === 1;
  const limiter = new RateLimiter(1, 60000);
  if (flag(1)) limiter.allow("ip");
  const gateway = createGateway({
    allowedOrigins: ["allowed.test"],
    authFailureLimiter: limiter,
    coreBaseUrl: "https://core.invalid",
    limits: { ...gatewayLimitsFromEnv({}), maxConnections: flag(2) ? 0 : 10 },
    spentTickets: { spend: async () => true, release: async () => {} },
    terminalTicketSecrets: [secret],
  });
  const paths = [
    "/v1/sandboxes/terminal/ws",
    "/v1/machines/ws",
    "/v1/projects/p/stages/s/observability/ws",
    "/v1/projects/p/stages/s/agents/a/ws",
    "/unknown",
  ];
  const request = new Request(`https://gateway.invalid${paths[v.route]}`, {
    headers: {
      upgrade: "websocket",
      origin: flag(0) ? "https://allowed.test" : "https://bad.test",
      ...(flag(3) ? { authorization: "Bearer test" } : {}),
    },
  });
  const server = {
    requestIP: () => ({ address: "ip" }),
    upgrade: () => true,
  } as unknown as Parameters<typeof gateway.fetch>[1];
  const previous = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(String(input as string | URL)).toBe(
        `https://core.invalid/v1/internal/${v.route === 2 ? "observability-scope" : "agent-socket-scope"}`,
      );
      expect(new Headers(init?.headers).get("x-broods-via-gateway")).toBe("1");
      if (!flag(4)) throw new Error("injected core outage");

      return Response.json(
        {
          accountId: "7",
          projectSlug: v.route === 3 || flag(6) ? "p" : "wrong",
          stageSlug: "s",
          endpointIds: [flag(6) ? "a" : "wrong"],
          ...(flag(7) ? { expiresAt: Date.now() + 1000 } : {}),
        },
        { status: flag(5) ? 200 : 401 },
      );
    },
    { preconnect: (): void => {} },
  );
  try {
    const response = await gateway.fetch(request, server);
    expect(response?.status ?? 101).toBe(v.result);
  } finally {
    globalThis.fetch = previous;
  }
}

const runtimeKeys = await import("../../apps/core/src/shared/runtime-keys.ts");

async function replayChild(
  v: Extract<Vector, { kind: "child" }>,
): Promise<void> {
  const f = v.fault;
  const parentId = `acct:${f === 6 ? "b" : "a"}:agent:parent:api:ev`;
  const task = runtimeKeys.createSubagentTaskId(
    parentId,
    "00000000-0000-4000-8000-000000000000",
  );
  const scope = {
    accountId: "a",
    endpointId: "e",
    projectSlug: "p",
    stageSlug: "s",
  };
  type Context = Parameters<typeof statusAccessDenial>[2];
  const conversationKey = `acct:a:agent:parent:api:${f === 14 ? "bsu:other:key" : "key"}`;
  const context: Context = {
    agentLoader: async () =>
      f === 7
        ? null
        : ({
            agentId: "parent",
            config: { publicAccess: f !== 8 },
            requireUserToken: f === 13,
          } as Awaited<ReturnType<Context["agentLoader"]>>),
    deploymentLoader: async () => (f === 9 ? null : scope),
    ingressStatusByEventIdLoader: async () =>
      f === 10
        ? null
        : ({
            eventId: f === 11 ? "wrong" : parentId,
            conversationKey: conversationKey,
            publicDeploymentIngress: f === 12 ? null : scope,
          } as Awaited<ReturnType<Context["ingressStatusByEventIdLoader"]>>),
    asyncAgentResultLoader: async () =>
      f === 1
        ? null
        : ({
            accountId: f === 2 ? "b" : "a",
            eventId: f === 3 ? "wrong" : "child-event",
            conversationKey: `acct:${f === 4 ? "b" : "a"}:agent:child:${f === 5 ? "wrong" : "api:"}key`,
          } as Awaited<ReturnType<Context["asyncAgentResultLoader"]>>),
  };
  const actual = await statusAccessDenial(
    { ...scope, account: { accountId: "a" } },
    {
      accountId: "a",
      agentId: "child",
      eventId: "child-event",
      publicEventId: task,
      ingress: {} as Parameters<typeof statusAccessDenial>[1]["ingress"],
    },
    context,
  );
  expect(actual?.code ?? null).toBe(
    [
      null,
      "public_access_disabled",
      "status_access_denied",
      "user_token_required",
    ][v.result],
  );
}

test("public health and refusal expose only gateway metadata", async (): Promise<void> => {
  const gateway = createGateway({
    allowedOrigins: ["allowed.test"],
    authFailureLimiter: new RateLimiter(20, 60000),
    coreBaseUrl: "https://core.invalid",
    limits: gatewayLimitsFromEnv({}),
    spentTickets: { spend: async () => true, release: async () => {} },
    terminalTicketSecrets: [secret],
  });
  const server = {
    requestIP: () => ({ address: "ip" }),
    upgrade: () => true,
  } as unknown as Parameters<typeof gateway.fetch>[1];
  const health = await gateway.fetch(
    new Request("https://gateway.invalid/healthz"),
    server,
  );
  expect(await health?.json()).toEqual({
    status: "ok",
    activeWebSockets: 0,
    maxWebSockets: 10000,
  });
  const response = await gateway.fetch(
    new Request("https://gateway.invalid/v1/agents/a/ws", {
      headers: { upgrade: "websocket", origin: "https://allowed.test" },
    }),
    server,
  );
  expect(response?.status).toBe(401);
  const body = await response?.text();
  expect(body).toContain("Missing WebSocket token");
  for (const value of [
    secret,
    process.env.SERVICE_AUTH_SECRET!,
    process.env.ADMIN_ACCOUNT_SECRET!,
  ])
    expect(body).not.toContain(value);
});

const { isSecretName } =
  await import("../../packages/convex/model/secretNames.ts");
