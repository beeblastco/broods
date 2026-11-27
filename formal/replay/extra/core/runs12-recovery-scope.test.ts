import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as handler from "../../../../apps/core/src/harness/handler.ts";
import * as ingress from "../../../../apps/core/src/harness/ingress.ts";
import type {
  AppliedIngress,
  RecoveredIngress,
} from "../../../../apps/core/src/harness/ingress.ts";
import type { IngressDispatchScope } from "../../../../apps/core/src/harness/integrations.ts";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";

const { startIngressRecovery, stopIngressRecovery } =
  await import("../../../../apps/core/src/harness/ingress-recovery.ts");

const KEY = "acct:acct_1:agent:agent_1:api:chat";

function applied(delivery: AppliedIngress["delivery"]): AppliedIngress {
  return {
    eventId: "event_1",
    events: [],
    delivery: delivery,
    requestedMode: "followup",
    appliedMode: "followup",
    appliedToEventId: "event_0",
    contributingEventIds: [],
    ownerGeneration: 1,
  };
}

function recovered(delivery: AppliedIngress["delivery"]): RecoveredIngress {
  return {
    accountId: "acct_1",
    agentId: "agent_1",
    conversationKey: KEY,
    applied: applied(delivery),
  };
}

async function scopesDispatched(
  entries: RecoveredIngress[],
): Promise<IngressDispatchScope[]> {
  const scopes: IngressDispatchScope[] = [];
  spyOn(ingress, "recoverQueuedIngress").mockResolvedValue({
    recovered: entries,
    continueAfter: null,
  });
  spyOn(handler, "dispatchAppliedIngress").mockImplementation(
    async (scope): Promise<void> => {
      scopes.push(scope);
    },
  );
  spyOn(runtime, "query").mockResolvedValue({
    page: [],
    cursor: "end",
    isDone: true,
  });
  startIngressRecovery();
  for (let i = 0; i < 200 && scopes.length < entries.length; i += 1) {
    await Bun.sleep(1);
  }
  stopIngressRecovery();

  return scopes;
}

afterEach((): void => {
  stopIngressRecovery();
  spyOn(ingress, "recoverQueuedIngress").mockRestore();
  spyOn(handler, "dispatchAppliedIngress").mockRestore();
  spyOn(runtime, "query").mockRestore();
});

describe("recovered ingress scope", (): void => {
  test("a channel delivery carries only the conversation and its public key", async (): Promise<void> => {
    const scopes = await scopesDispatched([
      recovered({ kind: "channel", channel: "telegram", source: {} } as never),
    ]);

    expect(scopes).toEqual([
      {
        accountId: "acct_1",
        agentId: "agent_1",
        conversationKey: KEY,
        publicConversationKey: "chat",
      },
    ]);
  });

  test("a deployment delivery adds the endpoint and stage it came through", async (): Promise<void> => {
    const scopes = await scopesDispatched([
      recovered({
        kind: "http",
        publicEventId: "event_1",
        publicConversationKey: "chat",
        publicDeploymentIngress: {
          accountId: "acct_1",
          endpointId: "endpoint_1",
          stageSlug: "dev",
          projectSlug: "shop",
        },
      }),
      recovered({
        kind: "async",
        publicEventId: "event_1",
        publicConversationKey: "chat",
        statusUrl: "https://core.test/v1/runs/run_1",
      }),
    ]);

    expect(scopes).toEqual([
      {
        accountId: "acct_1",
        agentId: "agent_1",
        conversationKey: KEY,
        publicConversationKey: "chat",
        endpointId: "endpoint_1",
        projectSlug: "shop",
        stageSlug: "dev",
      },
      {
        accountId: "acct_1",
        agentId: "agent_1",
        conversationKey: KEY,
        publicConversationKey: "chat",
      },
    ]);
  });
});
