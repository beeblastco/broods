import type { Doc } from "../_generated/dataModel";

/**
 * The stage a project opens on when none is named: the Development default,
 * else any Development stage, else the default, else the first. Shared by the
 * dashboard's stage picker and the queries that resolve a missing stage, so
 * both land on the same one.
 */
export function defaultStage<
  Stage extends Pick<Doc<"stages">, "isDefault" | "kind">,
>(stages: Stage[]): Stage | undefined {
  return (
    stages.find((stage) => stage.kind === "development" && stage.isDefault) ??
    stages.find((stage) => stage.kind === "development") ??
    stages.find((stage) => stage.isDefault) ??
    stages[0]
  );
}
