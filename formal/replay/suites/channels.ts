import type { Suite } from "../suite.ts";

export const suite: Suite = {
  name: "channels",
  tests: ["formal/replay/channels.test.ts"],
  env: {},
  mutations: [
    {
      name: "workspace record grants foreign refs",
      file: "apps/core/src/shared/domain/channel-record.ts",
      find: "(agentRefs ?? []).filter((ref): boolean => named.has(ref.workspaceId))",
      replace: "channelRefs",
    },
    {
      name: "skip webhook authentication",
      file: "apps/core/src/harness/integrations.ts",
      find: "if (!(await candidate.adapter.authenticate(request))) continue;",
      replace: "if (false) continue;",
    },
    {
      name: "ignore per-entry fanout",
      file: "apps/core/src/harness/integrations.ts",
      find: "if (!candidate.adapter.routesEachEntry) break;",
      replace: "break;",
    },
    {
      name: "last binding wins",
      file: "apps/core/src/shared/domain/channel-record.ts",
      find: "bindings[0]",
      replace: "bindings.at(-1)",
    },
    {
      name: "one shot cleanup omitted",
      file: "apps/core/src/harness/handler.ts",
      find: "if (cronRun.oneShot) await removeOneShotCron(accountId, cronRun.cronId);",
      replace: "if (false) await removeOneShotCron(accountId, cronRun.cronId);",
    },
    {
      name: "a paused cron run is failed at the short limit",
      file: "packages/convex/agent/crons.ts",
      find: "return now - run.startedAt > PAUSED_RUN_MAX_AGE_MS",
      replace: "return now - run.startedAt > DEAD_RUN_GRACE_MS",
    },
    {
      name: "an expired cron run is failed at the short limit",
      file: "packages/convex/agent/crons.ts",
      find: "return endedAgo > EXPIRED_RUN_GRACE_MS ? dead : null;",
      replace: "return endedAgo > DEAD_RUN_GRACE_MS ? dead : null;",
    },
    {
      name: "accept expired ticket",
      file: "apps/core/src/shared/media-ticket.ts",
      find: "parsed.data.exp * 1000 > now",
      replace: "true",
    },
  ],
};
