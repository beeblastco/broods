import {
  BroodsClient,
  type AgentReference,
} from "../../../packages/broods/src/client.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { signUserToken } from "../../../packages/broods/src/user-token.ts";
import { sealStageSessionTicket } from "../../../packages/convex/model/stageSessionTicket.ts";
import {
  sealUserToken,
  USER_TOKEN_HEADER,
} from "../../../packages/convex/model/userToken.ts";
import { OK_AGENT, assertStep, type VerifyContext } from "../harness.ts";

/**
 * The runtime key's user tokens, end to end through the edge, core and the
 * gateway: a new agent refuses the bare runtime key with
 * `user_token_required`, a token the stage did not sign fails the whole
 * credential with 401 on HTTP and on the agent socket's upgrade, and a
 * member's stage ticket still runs the agent without one. The account key
 * then rotates the stage's signing secret through the CLI route `broods dev`
 * and `broods deploy` call, and a token signed with it runs the agent under
 * that user's namespace.
 */
export async function userToken(context: VerifyContext): Promise<void> {
  const project = `user-token-${context.runId}`;
  const sync = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const deployed = await context.measure("deploy stage", () =>
    sync.putManifest(
      {
        version: 1,
        project: project,
        stage: "development",
        resources: [
          {
            kind: "agent",
            name: "public",
            config: { ...context.model, agent: OK_AGENT, publicAccess: true },
          },
        ],
      },
      true,
    ),
  );
  const { deployment } = deployed;
  const agentId = deployed.ids.agents.public;
  assertStep(
    "the deploy returned its runtime key and the agent id",
    deployment?.apiKey.startsWith("bsk_") === true && agentId !== undefined,
    JSON.stringify(deployed.ids),
  );
  assertStep(
    "a fresh stage reports no user token signing secret",
    deployment.userTokenSecretHint === undefined,
    JSON.stringify(deployment.userTokenSecretHint),
  );
  const runtimeKey = deployment.apiKey;
  const agent: AgentReference = {
    kind: "agent",
    name: "public",
    id: agentId,
    project: project,
    stage: "development",
    endpointId: deployment.endpointId,
    projectSlug: deployment.projectSlug,
    stageSlug: deployment.stageSlug,
  };
  const turn = { conversationKey: `${project}-chat`, input: "Say OK." };
  const agentPath = `/v1/projects/${deployment.projectSlug}/stages/${deployment.stageSlug}/agents/${deployment.endpointId}`;
  const forged = await sealUserToken(
    { userId: "mallory", expiresAt: Date.now() + 5 * 60_000 },
    `bsig_not-this-stage-${context.runId}`,
  );

  /** The status, error code and conversation key core answers one runtime-key run with. */
  const run = async (
    headers: Record<string, string>,
  ): Promise<{ status: number; code?: string; conversationKey?: string }> =>
    await context.measure("runtime key run", async () => {
      const response = await fetch(`${context.edgeUrl}${agentPath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtimeKey}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          agentId: agentId,
          background: true,
          eventId: crypto.randomUUID(),
          conversationKey: turn.conversationKey,
          events: [
            { role: "user", content: [{ type: "text", text: turn.input }] },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string };
        conversationKey?: string;
      };

      return {
        status: response.status,
        ...(body.error?.code ? { code: body.error.code } : {}),
        ...(body.conversationKey
          ? { conversationKey: body.conversationKey }
          : {}),
      };
    });

  const bare = await run({});
  assertStep(
    "a new agent refuses the runtime key without a user token",
    bare.status === 403 && bare.code === "user_token_required",
    JSON.stringify(bare),
  );
  const forgedRun = await run({ [USER_TOKEN_HEADER]: forged });
  assertStep(
    "a user token the stage did not sign fails the runtime key",
    forgedRun.status === 401,
    JSON.stringify(forgedRun),
  );

  /** The status the edge answers an agent socket upgrade with. */
  const upgrade = async (protocols: string): Promise<number> => {
    const response = await fetch(`${context.edgeUrl}${agentPath}/ws`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": btoa(crypto.randomUUID().slice(0, 16)),
        "sec-websocket-protocol": protocols,
      },
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();

    return response.status;
  };
  const forgedSocket = await upgrade(
    `broods.v1, broods.token.${runtimeKey}, broods.user.${forged}`,
  );
  assertStep(
    "the gateway refuses an agent socket whose user token the stage did not sign",
    forgedSocket === 401,
    `status ${forgedSocket}`,
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
  const accepted = await new BroodsClient({
    apiKey: ticket,
    baseUrl: context.edgeUrl,
  }).runAsync(agent, turn);
  assertStep(
    "a member's stage ticket runs the agent without a user token",
    accepted.runId.startsWith("run_"),
    JSON.stringify(accepted),
  );

  const rotated = await context.measure("rotate signing secret", () =>
    sync.rotateUserTokenSecret(project, "development"),
  );
  assertStep(
    "the account key rotates the stage's signing secret and gets it once",
    rotated?.secret.startsWith("bsig_") === true &&
      rotated.hint.startsWith("bsig_"),
    JSON.stringify(rotated?.hint),
  );
  const signed = await run({
    [USER_TOKEN_HEADER]: await signUserToken({
      userId: "alice",
      secret: rotated.secret,
    }),
  });
  assertStep(
    "a user token signed with the rotated secret runs the agent under its user",
    signed.status === 202 &&
      signed.conversationKey === `bsu:alice:${turn.conversationKey}`,
    JSON.stringify(signed),
  );
}
