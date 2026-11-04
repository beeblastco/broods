import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { json, jsonError, methodNotAllowed } from "../../model/httpJson";

const RANGES = ["1h", "3h", "1d", "7d", "30d", "1y"] as const;

// The dashboard's usage numbers, for one stage of this account.
export async function handleUsageRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const stage = url.searchParams.get("stage");
  if (!project || !stage)
    return jsonError(400, "usage needs ?project= and &stage=");
  const asked = url.searchParams.get("range") ?? "7d";
  const range = RANGES.find((entry) => entry === asked);
  if (!range)
    return jsonError(400, `range must be one of ${RANGES.join(", ")}`);
  const usage = await ctx.runQuery(internal.logs.usageForAccountStage, {
    accountId: accountId,
    project: project,
    stage: stage,
    range: range,
  });

  return usage
    ? json(usage)
    : jsonError(404, `No deployed stage ${project}/${stage}`);
}
