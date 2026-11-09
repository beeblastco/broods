import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { sourceFunctions } from "./channels-source.ts";

const savedFetch = globalThis.fetch;
globalThis.fetch = ((): never => {
  throw new Error("unstubbed network call");
}) as typeof fetch;
afterAll((): void => {
  globalThis.fetch = savedFetch;
});

const cron = await import("../../packages/convex/model/cronRules.ts");
const rules = await import("../../packages/convex/model/channelRules.ts");
const cmds = await import("../../apps/core/src/shared/commands.ts");
const ticket = await sourceFunctions<
  typeof import("../../apps/core/src/shared/media-ticket.ts")
>(
  "apps/core/src/shared/media-ticket.ts",
  ["openMediaTicket", "sealMediaTicket", "openWithSecret", "ticketKey"],
  {
    ...(await import("node:crypto")),
    TICKET_ALGORITHM: "aes-256-gcm",
    TICKET_VERSION: "ml2",
    DEFAULT_MEDIA_TICKET_TTL_SECONDS: 30 * 86400,
    positiveIntegerEnv: (): number => 30 * 86400,
    ticketPayload: (
      await import("../../packages/convex/node_modules/zod/index.js")
    ).z.union([
      (
        await import("../../packages/convex/node_modules/zod/index.js")
      ).z.strictObject({
        accountId: (
          await import("../../packages/convex/node_modules/zod/index.js")
        ).z.string(),
        path: (
          await import("../../packages/convex/node_modules/zod/index.js")
        ).z.string(),
        exp: (
          await import("../../packages/convex/node_modules/zod/index.js")
        ).z.number(),
      }),
      (
        await import("../../packages/convex/node_modules/zod/index.js")
      ).z.strictObject({
        accountId: (
          await import("../../packages/convex/node_modules/zod/index.js")
        ).z.string(),
        workspaceId: (
          await import("../../packages/convex/node_modules/zod/index.js")
        ).z.string(),
        namespace: (
          await import("../../packages/convex/node_modules/zod/index.js")
        ).z.string(),
        path: (
          await import("../../packages/convex/node_modules/zod/index.js")
        ).z.string(),
        exp: (
          await import("../../packages/convex/node_modules/zod/index.js")
        ).z.number(),
      }),
    ]),
  },
);
const record = await sourceFunctions<
  typeof import("../../apps/core/src/shared/domain/channel-record.ts")
>(
  "apps/core/src/shared/domain/channel-record.ts",
  [
    "applyChannelRecord",
    "selectWorkspaceRefs",
    "appendSystemInstructions",
    "resolveChannelAgentId",
    "channelRecordMatchesWorkspace",
    "channelActorRoles",
  ],
  { logWarn: (): void => {} },
);

interface Vector {
  kind: string;
  input: unknown;
  expected: unknown;
}
const result = spawnSync(
  `${import.meta.dir}/../.lake/build/bin/spec-replay`,
  ["channels"],
  {
    cwd: `${import.meta.dir}/..`,
    encoding: "utf8",
    maxBuffer: 1 << 24,
  },
);
if (result.status !== 0) throw new Error(result.stdout + result.stderr);
const vectors = result.stdout
  .trim()
  .split("\n")
  .map((s): Vector => JSON.parse(s) as Vector);

const integrationPath = "apps/core/src/harness/integrations.ts";
interface Holder {
  kind: string;
  receivers?: { agent: { agentId: string } }[];
}
let candidates: number[][] = [];
let listed = true;
const integration = await sourceFunctions<{
  scanChannelCredentialHolder: (...args: unknown[]) => Promise<Holder>;
  matchWebhookPath: (path: string) => unknown;
  channelReplySource: (
    adapter: unknown,
    message: unknown,
    rec: unknown,
  ) => unknown;
}>(
  integrationPath,
  [
    "scanChannelCredentialHolder",
    "matchWebhookPath",
    "decodePathSegments",
    "channelReplySource",
  ],
  {
    listWebhookAgents: async (): Promise<unknown[]> =>
      listed
        ? candidates
            .slice()
            .reverse()
            .map((c): unknown => ({
              agentId: String(c[0]),
              config: { channels: { test: c } },
            }))
        : [],
    createChannelRegistry: (config: {
      channels: { test: number[] };
    }): unknown => ({
      webhookChannels: [
        {
          name: "test",
          canHandle: (): boolean => true,
          authenticate: (): boolean => config.channels.test[1] === 1,
          routesEachEntry: config.channels.test[2] === 1,
        },
      ],
    }),
    CHANNEL_CREDENTIAL_CANDIDATE_LIMIT: 25,
    logInfo: (): void => {},
    logWarn: (): void => {},
  },
);
const mediaSource = await Bun.file(
  `${import.meta.dir}/../../apps/core/src/harness/channel-media.ts`,
).text();
const nativeTable = mediaSource.slice(
  mediaSource.indexOf(
    "= {",
    mediaSource.indexOf("const PROVIDER_NATIVE_MEDIA"),
  ) + 2,
  mediaSource.indexOf(
    "\n};",
    mediaSource.indexOf("const PROVIDER_NATIVE_MEDIA"),
  ) + 2,
);
const native = await sourceFunctions<{
  acceptsNativeMedia: (p: string | undefined, m: string) => boolean;
}>("apps/core/src/harness/channel-media.ts", ["acceptsNativeMedia"], {
  // oxlint-disable-next-line typescript/no-implied-eval -- evaluates code taken from the real source on purpose
  PROVIDER_NATIVE_MEDIA: new Function(`return (${nativeTable})`)(),
  getTopLevelMediaType: (s: string): string => s.split("/")[0] ?? "",
});

const indexedVectors = vectors.map(
  (vector, index): { vector: Vector; name: string } => ({
    vector: vector,
    name: `${vector.kind} ${index}`,
  }),
);
test.each(
  indexedVectors.filter(
    ({ vector }): boolean =>
      vector.kind !== "date" || vector.expected !== false,
  ),
)("Lean $name", ({ vector }): Promise<void> => replay(vector));
test.failing.each(
  indexedVectors.filter(
    ({ vector }): boolean =>
      vector.kind === "date" && vector.expected === false,
  ),
)("G500 calendar $name", ({ vector }): Promise<void> => replay(vector));

interface CronSweepInput {
  tracked: boolean;
  startedAt: number;
  now: number;
  status?: string;
  updatedAt?: number;
  paused?: boolean;
}

// Runs the real `deadRunOutcome` with its own constants, on a database answering from the vector.
async function replayCronSweep(input: CronSweepInput): Promise<string> {
  const path = "packages/convex/agent/crons.ts";
  const source = await Bun.file(`${import.meta.dir}/../../${path}`).text();
  const constant = (name: string): number =>
    (new RegExp(`const ${name} = ([\\d\\s*]+);`).exec(source)?.[1] ?? "")
      .split("*")
      .reduce((product, factor): number => product * Number(factor), 1);
  const { deadRunOutcome } = await sourceFunctions<{
    deadRunOutcome: (
      ctx: unknown,
      run: unknown,
      now: number,
    ) => Promise<{ status: string; error?: string } | null>;
  }>(path, ["deadRunOutcome"], {
    DEAD_RUN_GRACE_MS: constant("DEAD_RUN_GRACE_MS"),
    EXPIRED_RUN_GRACE_MS: constant("EXPIRED_RUN_GRACE_MS"),
    PAUSED_RUN_MAX_AGE_MS: constant("PAUSED_RUN_MAX_AGE_MS"),
    UNTRACKED_RUN_MAX_AGE_MS: constant("UNTRACKED_RUN_MAX_AGE_MS"),
    DEAD_RUN_ERROR: "dead",
    UNANSWERED_RUN_ERROR: "unanswered",
  });
  const rows: Record<string, unknown> = {
    runtimeIngressEnvelopes:
      input.status === undefined
        ? null
        : { status: input.status, updatedAt: input.updatedAt, error: "boom" },
    runtimeAsyncAgentResults: {
      status: input.paused === true ? "awaiting_approval" : "completed",
    },
  };
  const ctx = {
    db: {
      query: (table: string) => ({
        withIndex: () => ({ first: async (): Promise<unknown> => rows[table] }),
      }),
    },
  };
  const outcome = await deadRunOutcome(
    ctx,
    {
      startedAt: input.startedAt,
      ingressEventId: input.tracked ? "event" : undefined,
    },
    input.now,
  );
  if (outcome === null) return "wait";
  if (outcome.status === "completed") return "finished";
  if (outcome.error === "dead") return "failedDead";

  return outcome.error === "unanswered" ? "failedUnanswered" : "failedEnvelope";
}

async function replay(v: Vector): Promise<void> {
  switch (v.kind) {
    case "rewrite": {
      const normalise = await sourceFunctions<
        typeof import("../../apps/core/src/harness/integrations.ts")
      >(
        integrationPath,
        [
          "rewriteLatestUserIngressText",
          "rewriteUserContentText",
          "attachMetadataToLatestUserIngress",
        ],
        {},
      );
      const es = (v.input as [boolean, string][]).map(
        ([user, text]): { role: "user" | "system"; content: string } => ({
          role: user ? "user" : "system",
          content: text,
        }),
      );
      const rewritten = normalise.rewriteLatestUserIngressText(
        es,
        "replacement",
      );
      expect(
        rewritten.map((e): [boolean, unknown] => [
          e.role === "user",
          e.content,
        ]),
      ).toEqual(v.expected);
      expect(es.map((e): string => e.content)).toEqual(["0", "1", "2", "3"]);
      break;
    }
    case "owners": {
      const { groupConnectionsByToken } =
        await import("../../apps/discord-forwarder/src/supervisor.ts");
      const groups = groupConnectionsByToken(
        (v.input as number[]).map(
          (
            t,
          ): {
            botToken: string;
            agentId: string;
            agentName: string;
            webhookUrl: string;
          } => ({
            botToken: String(t),
            agentId: "a",
            agentName: "A",
            webhookUrl: "https://invalid",
          }),
        ),
      );
      expect([...groups.keys()].map(Number)).toEqual(v.expected);
      break;
    }
    case "media": {
      const [valid, present, size] = v.input as number[];
      mediaPresent = present === 1;
      mediaSize = size ?? 0;
      const response = await media.handleMediaRequest({
        path: `/v1/media/${valid === 1 ? "valid" : "invalid"}`,
        method: "HEAD",
      });
      expect(response.status).toBe(v.expected);
      expect(await response.text()).toBe("");
      break;
    }
    case "workspaces": {
      const [agent, selected] = v.input as number[][];
      const refs = (agent ?? []).map(
        (id): { name: string; workspaceId: string } => ({
          name: `original-${id}`,
          workspaceId: String(id),
        }),
      );
      const config = record.applyChannelRecord(
        { workspaces: refs },
        channelRecord({
          workspaces: (selected ?? []).map(
            (id): { name: string; workspaceId: string } => ({
              name: "renamed",
              workspaceId: String(id),
            }),
          ),
        }),
        "test",
      );
      expect(
        config.workspaces?.map((r): number => Number(r.workspaceId)),
      ).toEqual(v.expected);
      expect(
        config.workspaces?.every(
          (r): boolean => r.name === `original-${r.workspaceId}`,
        ),
      ).toBe(true);
      break;
    }
    case "tools": {
      const [agent, denied] = v.input as number[][];
      const config = record.applyChannelRecord(
        { denyTools: ["old"] },
        channelRecord({ denyTools: (denied ?? []).map(String) }),
        "test",
      );
      expect(
        (agent ?? []).filter(
          (id): boolean => !config.denyTools?.includes(String(id)),
        ),
      ).toEqual(v.expected);
      expect(config.denyTools).toContain("old");
      break;
    }
    case "date": {
      const [y, m, d, h, n, s] = v.input as number[];
      const expression = `at(${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(n).padStart(2, "0")}:${String(s).padStart(2, "0")})`;
      if (v.expected === false)
        expect((): unknown =>
          cron.translateScheduleExpression(expression, undefined),
        ).toThrow();
      else {
        const translated = cron.translateScheduleExpression(
          expression,
          undefined,
        );
        expect(translated).toEqual({
          kind: "at",
          timestamp: Date.UTC(y ?? 0, (m ?? 1) - 1, d, h, n, s),
        });
        if (translated.kind === "at")
          expect(
            new Date(translated.timestamp).toISOString().slice(0, 19),
          ).toBe(expression.slice(3, -1));
      }
      break;
    }
    case "rate": {
      const [count, unit] = v.input as number[];
      const expression = `rate(${count} ${["minutes", "hours", "days", "seconds"][unit ?? 3]})`;
      if (v.expected === null)
        expect((): unknown =>
          cron.translateScheduleExpression(expression, undefined),
        ).toThrow();
      else
        expect(cron.translateScheduleExpression(expression, undefined)).toEqual(
          { kind: "interval", ms: v.expected },
        );
      break;
    }
    case "alias": {
      let valid = true;
      try {
        rules.normalizeChannelRecordConfig({
          agentBindings: [{ agentId: "a" }],
          partition: { by: "conversation", alias: v.input },
        });
      } catch {
        valid = false;
      }
      expect(valid).toBe(v.expected);
      break;
    }
    case "native": {
      const [p, m] = v.input as number[];
      expect(
        native.acceptsNativeMedia(
          [
            "anthropic",
            "azure",
            "bedrock",
            "openai",
            "google",
            "vertex",
            undefined,
            "other",
          ][p ?? 7],
          [
            "image/png",
            "application/pdf",
            "audio/ogg",
            "video/mp4",
            "text/plain",
          ][m ?? 4] ?? "",
        ),
      ).toBe(v.expected);
      break;
    }
    case "command": {
      const input = v.input as { token: string; text: boolean };
      const token =
        cmds.parseCommand(
          `  ${input.token.toUpperCase()}${input.text ? " hi" : ""}`,
        ) ?? undefined;
      const outcome = cmds.resolveChannelCommand({
        content: `${input.token}${input.text ? " hi" : ""}`,
        commandToken: token,
      });
      const code =
        outcome.kind === "passthrough"
          ? 0
          : outcome.kind === "reply"
            ? 3
            : outcome.requestedMode === "steer"
              ? 1
              : 2;
      expect(code).toBe(v.expected);
      break;
    }
    case "holders": {
      candidates = v.input as number[][];
      const holder = await integration.scanChannelCredentialHolder(
        {},
        "account",
        "test",
        {},
      );
      expect(
        holder.receivers?.map((r): number => Number(r.agent.agentId)) ?? [],
      ).toEqual(v.expected);
      break;
    }
    case "cronSweep": {
      const input = v.input as CronSweepInput;
      expect(await replayCronSweep(input)).toBe(v.expected);
      break;
    }
    case "reply": {
      const input = v.input as { incoming: number | null; thread: boolean };
      const source = {
        channelId: "2",
        messageTs: "3",
        inThreadTs:
          input.incoming === null ? undefined : String(input.incoming),
        threadTs: "9",
      };
      // The provider's actual method is loaded verbatim below, including its source parser.
      const text = await Bun.file(
        `${import.meta.dir}/../../apps/core/src/shared/slack-channel.ts`,
      ).text();
      const start = text.indexOf("applyReplyIn: function");
      const method = text.slice(start, text.indexOf("\n    },", start) + 6);
      const parsed = new Bun.Transpiler({ loader: "ts" }).transformSync(
        `const adapter = {${method}};`,
      );
      // oxlint-disable-next-line typescript/no-implied-eval -- evaluates code taken from the real source on purpose
      const adapter = new Function(
        "toSlackSource",
        `${parsed}; return adapter;`,
      )((s: unknown): unknown => s);
      const output = integration.channelReplySource(
        adapter,
        { source: source },
        { config: { replyIn: input.thread ? "thread" : "source" } },
      ) as typeof source;
      expect(output.channelId).toBe(source.channelId);
      expect(
        output.threadTs === undefined ? null : Number(output.threadTs),
      ).toEqual(v.expected);
      break;
    }
  }
}

function channelRecord(
  config: Partial<ReturnType<typeof rules.normalizeChannelRecordConfig>>,
): Parameters<typeof record.applyChannelRecord>[1] {
  return {
    accountId: "a",
    channelRecordId: "r",
    platform: "test",
    externalId: "x",
    name: "test",
    status: "active",
    createdAt: "",
    updatedAt: "",
    config: { agentBindings: [{ agentId: "a" }], ...config },
  };
}

test("binding, workspace scope and tag roles", (): void => {
  const r = channelRecord({
    agentBindings: [{ agentId: "first" }, { agentId: "last" }],
  });
  expect(record.resolveChannelAgentId(r)).toBe("first");
  r.config.agentBindings[1]!.isDefault = true;
  expect(record.resolveChannelAgentId(r)).toBe("last");
  expect(record.channelRecordMatchesWorkspace("a", "b")).toBe(false);
  expect(record.channelRecordMatchesWorkspace(undefined, "b")).toBe(true);
});
test("both webhook shapes, malformed escapes and retired URL", (): void => {
  expect(integration.matchWebhookPath("/v1/webhooks/ac/slack")).toEqual({
    accountId: "ac",
    channelName: "slack",
  });
  expect(integration.matchWebhookPath("/v1/webhooks/ac/dev/st/slack")).toEqual({
    accountId: "ac",
    endpointId: "st",
    channelName: "slack",
  });
  expect(integration.matchWebhookPath("/v1/webhooks/ac/st/slack")).toBeNull();
  expect(integration.matchWebhookPath("/v1/webhooks/%xx/slack")).toBeNull();
});
test("unknown stage is distinguished from unconfigured account", async (): Promise<void> => {
  listed = false;
  expect(
    (
      await integration.scanChannelCredentialHolder(
        {},
        "a",
        "test",
        {},
        "missing",
      )
    ).kind,
  ).toBe("unknown-stage");
  expect(
    (await integration.scanChannelCredentialHolder({}, "a", "test", {})).kind,
  ).toBe("unconfigured");
  listed = true;
});

test("media seal/open, rotation, tampering and exact expiry", (): void => {
  const sealed = ticket.sealMediaTicket(
    { accountId: "a", path: "file.png" },
    "secret",
    1000,
  );
  expect(
    ticket.openMediaTicket(sealed, ["wrong", "secret"], 1000)?.accountId,
  ).toBe("a");
  expect(ticket.openMediaTicket(sealed, ["wrong"], 1000)).toBeNull();
  expect(
    ticket.openMediaTicket(sealed + ".extra", ["secret"], 1000),
  ).toBeNull();
  expect(
    ticket.openMediaTicket(sealed, ["secret"], 1000 + 30 * 86400 * 1000),
  ).toBeNull();
});

const calls: string[] = [];
const handler = await sourceFunctions<{
  createCronDirectEvent: (
    job: unknown,
    at: Date,
  ) => Promise<{ publicEventId: string }>;
  settleCronRun: (
    account: string,
    run: unknown,
    outcome: unknown,
  ) => Promise<void>;
  removeOneShotCron: (account: string, id: string) => Promise<void>;
}>(
  "apps/core/src/harness/handler.ts",
  ["createCronDirectEvent", "settleCronRun", "removeOneShotCron"],
  {
    crypto: crypto,
    createRunId: (): string => "run",
    toRuntimeAgentConfig: (c: unknown): unknown => c,
    resolveReentryTarget: async (): Promise<object> => ({}),
    scopedDirectEventId: (...v: string[]): string => v.join(":"),
    withScheduledRunContext: (): unknown[] => [],
    logError: (): void => {},
    getStorage: (): unknown => ({
      agents: { getById: async (): Promise<object> => ({ config: {} }) },
      crons: {
        failRun: async (): Promise<void> => {
          calls.push("failed");
        },
        completeRun: async (): Promise<void> => {
          calls.push("completed");
        },
        remove: async (): Promise<void> => {
          calls.push("removed");
        },
      },
    }),
  },
);
test.failing(
  "G2 D7 duplicate cron/fire-time has stable event id",
  async (): Promise<void> => {
    const job = { accountId: "a", agentId: "agent", cronId: "cron" };
    const first = await handler.createCronDirectEvent(job, new Date(0));
    const second = await handler.createCronDirectEvent(job, new Date(0));
    expect(first.publicEventId).toBe(second.publicEventId);
  },
);
test("one shot settlement and failure attempt deletion, intermediate outcome retains it", async (): Promise<void> => {
  for (const status of ["completed", "failed", "running"]) {
    calls.length = 0;
    await handler.settleCronRun(
      "a",
      { cronId: "c", runId: "r", oneShot: true },
      { status: status },
    );
    expect(calls).toEqual(status === "running" ? [] : [status, "removed"]);
  }
});

const media = await sourceFunctions<{
  handleMediaRequest: (request: unknown) => Promise<Response>;
}>("apps/core/src/media.ts", ["handleMediaRequest"], {
  MEDIA_PATH_PREFIX: "/v1/media/",
  MAX_MEDIA_BYTES: 25 * 1024 * 1024,
  openMediaTicket: (token: string): unknown =>
    token === "valid"
      ? { accountId: "a", path: "x.png", exp: 9999999999 }
      : null,
  requireSecretsEnv: (): string[] => ["key"],
  logWarn: (): void => {},
  logDebug: (): void => {},
  locateMediaObject: async (): Promise<unknown> =>
    mediaPresent ? { head: { contentLength: mediaSize } } : null,
  readMediaObject: async (): Promise<Uint8Array> => new Uint8Array([1, 2]),
  contentTypeForPath: (): string => "image/png",
  notFound: (): Response => new Response(null, { status: 404 }),
  errorResponse: (status: number): Response =>
    new Response(null, { status: status }),
});
let mediaPresent = true;
let mediaSize = 100;

test("cron entry skips missing and paused, deletes refused and start-failed one-shots", async (): Promise<void> => {
  let job: {
    accountId: string;
    cronId: string;
    agentId: string;
    status: string;
    scheduleExpression: string;
  } | null = null;
  let refused = false;
  let startFailed = false;
  const effects: string[] = [];
  const entry = await sourceFunctions<{
    handleScheduledCron: (event: unknown) => Promise<unknown>;
  }>(
    "apps/core/src/harness/handler.ts",
    ["handleScheduledCron", "scheduledFireTime"],
    {
      getStorage: (): unknown => ({
        crons: {
          getById: async (): Promise<unknown> => job,
          markFailed: async (): Promise<void> => {
            effects.push("failed");
          },
        },
      }),
      logInfo: (): void => {},
      logError: (): void => {},
      admitRun: async (): Promise<unknown> => ({
        refusal: refused ? { message: "limit" } : null,
      }),
      isOneTimeSchedule: cron.isOneTimeSchedule,
      removeOneShotCron: async (): Promise<void> => {
        effects.push("removed");
      },
      startScheduledAgentRun: async (): Promise<object> => {
        effects.push("start");
        if (startFailed) throw new Error("start failed");
        return {};
      },
    },
  );
  await entry.handleScheduledCron({ accountId: "a", cronId: "c" });
  expect(effects).toEqual([]);
  job = {
    accountId: "a",
    cronId: "c",
    agentId: "agent",
    status: "paused",
    scheduleExpression: "at(2026-01-01T00:00:00)",
  };
  await entry.handleScheduledCron({ accountId: "a", cronId: "c" });
  expect(effects).toEqual([]);
  job.status = "active";
  refused = true;
  await entry.handleScheduledCron({ accountId: "a", cronId: "c" });
  expect(effects).toEqual(["failed", "removed"]);
  effects.length = 0;
  refused = false;
  startFailed = true;
  await expect(
    entry.handleScheduledCron({ accountId: "a", cronId: "c" }),
  ).rejects.toThrow("start failed");
  expect(effects).toEqual(["start", "removed"]);
});

test.failing(
  "G501 terminal recording failure still deletes one-shot",
  async (): Promise<void> => {
    let removed = false;
    const settle = await sourceFunctions<{
      settleCronRun: (a: string, r: unknown, o: unknown) => Promise<void>;
    }>("apps/core/src/harness/handler.ts", ["settleCronRun"], {
      getStorage: (): unknown => ({
        crons: {
          completeRun: async (): Promise<never> => {
            throw new Error("storage unavailable");
          },
        },
      }),
      removeOneShotCron: async (): Promise<void> => {
        removed = true;
      },
    });
    await settle
      .settleCronRun(
        "a",
        { oneShot: true, cronId: "c", runId: "r" },
        { status: "completed" },
      )
      .catch((): void => {});
    expect(removed).toBe(true);
  },
);

test("best effort removal swallows rejection", async (): Promise<void> => {
  const removal = await sourceFunctions<{
    removeOneShotCron: (a: string, c: string) => Promise<void>;
  }>("apps/core/src/harness/handler.ts", ["removeOneShotCron"], {
    getStorage: (): unknown => ({
      crons: {
        remove: async (): Promise<never> => {
          throw new Error("offline");
        },
      },
    }),
    logError: (): void => {},
  });
  await expect(removal.removeOneShotCron("a", "c")).resolves.toBeUndefined();
});

test("startScheduledAgentRun success and failed admission", async (): Promise<void> => {
  const effects: string[] = [];
  let owned = true;
  const start = await sourceFunctions<{
    startScheduledAgentRun: (j: unknown, d: Date) => Promise<unknown>;
  }>("apps/core/src/harness/handler.ts", ["startScheduledAgentRun"], {
    openCronRun: async (): Promise<unknown> => ({
      event: { publicEventId: "e", publicConversationKey: "key" },
      run: { runId: "r" },
    }),
    isOneTimeSchedule: cron.isOneTimeSchedule,
    admitInternalContinuation: async (e: unknown): Promise<unknown> => ({
      owned: owned ? e : null,
    }),
    continuationDelivery: (): object => ({}),
    createPendingAsyncAgentResult: async (): Promise<void> => {
      effects.push("pending");
    },
    invokeAsyncWorker: async (): Promise<void> => {
      effects.push("worker");
    },
    getStorage: (): unknown => ({
      crons: {
        failRun: async (): Promise<void> => {
          effects.push("failed");
        },
      },
    }),
  });
  const job = {
    accountId: "a",
    cronId: "c",
    scheduleExpression: "at(2026-01-01T00:00:00)",
  };
  expect(await start.startScheduledAgentRun(job, new Date(0))).toEqual({
    eventId: "e",
    conversationKey: "key",
  });
  expect(effects).toEqual(["pending", "worker"]);
  effects.length = 0;
  owned = false;
  await expect(start.startScheduledAgentRun(job, new Date(0))).rejects.toThrow(
    "already processing",
  );
  expect(effects).toEqual(["failed"]);
});

test("forwarder owns one live socket per token across target changes", async (): Promise<void> => {
  const { Forwarder } =
    await import("../../apps/discord-forwarder/src/supervisor.ts");
  let opened = 0;
  let stopped = 0;
  const forwarder = new Forwarder(
    { planes: [], backoffCeilingMs: 300000, identifyLimit: 500, port: 0 },
    (): import("../../apps/discord-forwarder/src/supervisor.ts").ForwarderSocket => {
      opened += 1;

      return {
        botIdentity: null,
        state: "ready",
        start: (): void => {},
        stop: (): void => {
          stopped += 1;
        },
      };
    },
  );
  const a = {
    botToken: "token",
    agentId: "a",
    agentName: "A",
    webhookUrl: "https://invalid/a",
  };
  forwarder.reconcile([
    a,
    { ...a, agentId: "b", webhookUrl: "https://invalid/b" },
  ]);
  expect(opened).toBe(1);
  expect(forwarder.status().sockets).toHaveLength(1);
  forwarder.reconcile([{ ...a, webhookUrl: "https://invalid/new" }]);
  expect(opened).toBe(1);
  forwarder.reconcile([]);
  expect(stopped).toBe(1);
  expect(forwarder.status().sockets).toHaveLength(0);
});

test("stale socket close cannot change ownership; fatal close cannot reconnect", async (): Promise<void> => {
  const { GatewaySocket } =
    await import("../../apps/discord-forwarder/src/socket.ts");
  const { IdentifyBudget } =
    await import("../../apps/discord-forwarder/src/identify-budget.ts");
  const socket = new GatewaySocket({
    botToken: "test",
    budget: new IdentifyBudget(1),
    config: { planes: [], identifyLimit: 1, backoffCeilingMs: 300000, port: 0 },
    onMessageCreate: (): void => {},
  });
  const internal = socket as unknown as {
    socket: object | null;
    handleClose: (ws: object, code: number, reason: string) => void;
  };
  const owner = {};
  internal.socket = owner;
  socket.state = "ready";
  internal.handleClose({}, 4004, "stale");
  expect(socket.state).toBe("ready");
  expect(internal.socket).toBe(owner);
  internal.handleClose(owner, 4004, "fatal");
  expect(socket.state).toBe("fatal");
  expect(internal.socket).toBeNull();
});

test("cron envelope translation and rejected unsupported syntax", (): void => {
  expect(cron.translateScheduleExpression("cron(0 12 ? * 1 *)", "UTC")).toEqual(
    { kind: "cron", cronspec: "0 12 * * 0", tz: "UTC" },
  );
  expect(
    cron.translateScheduleExpression("cron(0 12 ? * 2-6/2 *)", undefined),
  ).toEqual({ kind: "cron", cronspec: "0 12 * * 1-5/2" });
  for (const expression of [
    "cron(0 12 ? * 0 *)",
    "cron(0 12 ? * 8 *)",
    "cron(0 12 L * ? *)",
    "cron(0 12 ? * MON 2026)",
    "cron(0 12 * * *)",
  ]) {
    expect((): unknown =>
      cron.translateScheduleExpression(expression, undefined),
    ).toThrow();
  }
});
