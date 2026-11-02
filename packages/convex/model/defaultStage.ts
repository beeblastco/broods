import type { Doc } from "../_generated/dataModel";

type RankedStage = Pick<Doc<"stages">, "isDefault" | "kind" | "name">;

export function byDefaultThenName(
  a: Pick<RankedStage, "isDefault" | "name">,
  b: Pick<RankedStage, "isDefault" | "name">,
): number {
  return a.isDefault !== b.isDefault
    ? a.isDefault
      ? -1
      : 1
    : a.name.localeCompare(b.name);
}

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
