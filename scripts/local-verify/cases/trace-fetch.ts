import { fetchObservabilityTrace } from "../../../packages/broods/src/observability-client.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { sealStageSessionTicket } from "../../../packages/convex/model/stageSessionTicket.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

// The local stack runs no Tempo, in CI too; a deployed gateway does.
const NO_TEMPO = "Trace history is not configured (TEMPO_URL)";
const NOT_FOUND = "Trace not found in this stage";

export async function traceFetch(context: VerifyContext): Promise<void> {
  const project = `trace-${context.runId}`;
  const { deployment } = await context.measure("deploy stage", () =>
    new BroodsSyncClient({
      baseUrl: context.edgeUrl,
      token: context.accountSecret,
    }).putManifest(
      {
        version: 1,
        project: project,
        stage: "development",
        resources: [
          {
            kind: "agent",
            name: "chat",
            config: { model: context.model.model, agent: { system: "OK" } },
          },
        ],
      },
      true,
    ),
  );
  assertStep(
    "the deploy returned its endpoint",
    deployment != null,
    "no deployment",
  );
  const ticket = await sealStageSessionTicket(
    {
      accountId: deployment.accountId,
      endpointId: deployment.endpointId,
      projectId: project,
      projectSlug: deployment.projectSlug,
      stageId: deployment.stageSlug,
      stageSlug: deployment.stageSlug,
      expiresAt: Date.now() + 15 * 60_000,
    },
    context.stageTicketSecret,
  );
  const answer = await context.measure("fetch an unknown trace", () =>
    fetchObservabilityTrace(
      {
        baseUrl: context.edgeUrl,
        credential: async (): Promise<string> => ticket,
        project: deployment.projectSlug,
        stage: deployment.stageSlug,
      },
      crypto.randomUUID().replaceAll("-", ""),
    ).then(
      (rows): string => `resolved with ${rows.length} spans`,
      (error: unknown): string =>
        error instanceof Error ? error.message : String(error),
    ),
  );
  assertStep(
    "the gateway answers fetchTrace for an id outside the stage with a refusal",
    answer === NO_TEMPO || answer === NOT_FOUND,
    answer,
  );
}
