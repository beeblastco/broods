import type { Doc } from "@broods/convex/_generated/dataModel";
import {
  SANDBOX_IMAGES,
  type SandboxImage,
} from "@broods/convex/model/sandboxRules";

/** One choice in the sandbox node's Snapshot select. */
export interface SnapshotOption {
  value: string;
  label: string;
}

/** A snapshot row as `listForActiveOrg` returns it, with its stage's name. */
type SnapshotRow = Pick<
  Doc<"sandboxSnapshots">,
  "name" | "provider" | "status" | "externalImageId" | "scope"
> & { stageName?: string };

/**
 * The Snapshot select's choices for a sandbox node: "None", then the active
 * snapshots for the node's provider taken on the node's stage, pinned by
 * provider image id and labelled with that stage. A snapshot is locked to the
 * stage it was taken on, so another stage's never shows as a choice. A pin set
 * in code that is not in the list still shows, so the select never hides what
 * the config holds; when it is another stage's snapshot, the label says it
 * cannot boot here.
 */
export function snapshotOptions(
  rows: ReadonlyArray<SnapshotRow>,
  provider: string,
  pinned: string | undefined,
  stageId: string | null,
): SnapshotOption[] {
  const options: SnapshotOption[] = [
    { value: "none", label: "None" },
    ...rows
      .filter(
        (row) =>
          row.provider === provider &&
          row.status === "active" &&
          typeof row.scope === "object" &&
          row.scope.stageId === stageId,
      )
      .map((row): SnapshotOption => ({
        value: row.externalImageId,
        label: `${row.name} · ${snapshotStage(row)}`,
      })),
  ];
  if (pinned && !options.some((option) => option.value === pinned)) {
    const row = rows.find((candidate) => candidate.externalImageId === pinned);
    options.push({
      value: pinned,
      label: row
        ? `${row.name} · ${snapshotStage(row)}, cannot boot here`
        : pinned,
    });
  }

  return options;
}

/** Where a snapshot was taken, as the Snapshots table and picker show it. */
export function snapshotStage(
  row: Pick<SnapshotRow, "scope" | "stageName">,
): string {
  if (row.scope === undefined) return "no stage, take again";
  if (row.scope === "account") return "account";

  return row.stageName ?? "deleted stage";
}

/**
 * The image variant a lambda snapshot was built from, for the Image select to
 * follow when that snapshot is picked. A snapshot of the default image, or one
 * the list does not hold, has none.
 */
export function snapshotImage(
  rows: ReadonlyArray<
    Pick<Doc<"sandboxSnapshots">, "baseImage" | "externalImageId">
  >,
  pinned: string,
): SandboxImage | undefined {
  const row = rows.find((candidate) => candidate.externalImageId === pinned);

  return SANDBOX_IMAGES.find((image) => image === row?.baseImage);
}
