import { v, type Infer } from "convex/values";
import { mutation } from "./_generated/server";
import { authKit } from "./auth";
import { sealUserToken, USER_TOKEN_MAX_TTL_MS } from "./model/userToken";

const AGENT_PATH =
  /^\/v1\/projects\/([^/]+)\/stages\/([^/]+)\/agents\/([^/]+)\/?$/;

const sessionValidator = v.object({
  agentId: v.string(),
  endpointId: v.string(),
  expiresAt: v.number(),
  projectSlug: v.string(),
  runtimeKey: v.string(),
  stageSlug: v.string(),
  userToken: v.string(),
});

type DockSession = Infer<typeof sessionValidator>;

// The dock talks to one Broods agent per deployment, as the signed-in user; null keeps its planner.
export const session = mutation({
  args: {},
  returns: v.union(sessionValidator, v.null()),
  handler: async (ctx): Promise<DockSession | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");
    const agent = dockAgent();
    if (!agent) return null;

    const expiresAt = Date.now() + USER_TOKEN_MAX_TTL_MS;
    const userToken = await sealUserToken(
      { userId: authUser.id, expiresAt: expiresAt },
      agent.userTokenSecret,
    );

    return {
      agentId: agent.agentId,
      endpointId: agent.endpointId,
      expiresAt: expiresAt,
      projectSlug: agent.projectSlug,
      runtimeKey: agent.runtimeKey,
      stageSlug: agent.stageSlug,
      userToken: userToken,
    };
  },
});

function dockAgent(): {
  agentId: string;
  endpointId: string;
  projectSlug: string;
  runtimeKey: string;
  stageSlug: string;
  userTokenSecret: string;
} | null {
  const url = process.env.BROODS_AGENT_URL;
  const agentId = process.env.BROODS_AGENT_ID;
  const runtimeKey = process.env.BROODS_AGENT_RUNTIME_KEY;
  const userTokenSecret = process.env.BROODS_AGENT_USER_TOKEN_SECRET;
  if (!url || !agentId || !runtimeKey || !userTokenSecret) return null;
  const match = AGENT_PATH.exec(new URL(url).pathname);
  if (!match) return null;
  const [, projectSlug, stageSlug, endpointId] = match;

  return {
    agentId: agentId,
    endpointId: decodeURIComponent(endpointId),
    projectSlug: decodeURIComponent(projectSlug),
    runtimeKey: runtimeKey,
    stageSlug: decodeURIComponent(stageSlug),
    userTokenSecret: userTokenSecret,
  };
}
