import type { Doc } from "../_generated/dataModel";

type RankedStage = Pick<Doc<"stages">, "isDefault" | "kind" | "name">;

/** Stage list order: the default first, then by name. */
export function byDefaultThenName(a: RankedStage, b: RankedStage): number {
  return a.isDefault !== b.isDefault
    ? a.isDefault
      ? -1
      : 1
    : a.name.localeCompare(b.name);
}

/**
 * The stage a project opens on when none is named: the Development default,
 * else any Development stage, else the default, else the first. Shared by the
 * dashboard's stage picker and the queries that resolve a missing stage, and
 * ranked in list order first, so both land on the same one whatever order
 * they read the stages in.
 */
export function defaultStage<Stage extends RankedStage>(
  stages: Stage[],
): Stage | undefined {
  const ranked = [...stages].sort(byDefaultThenName);

  return (
    ranked.find((stage) => stage.kind === "development" && stage.isDefault) ??
    ranked.find((stage) => stage.kind === "development") ??
    ranked.find((stage) => stage.isDefault) ??
    ranked[0]
  );
}
