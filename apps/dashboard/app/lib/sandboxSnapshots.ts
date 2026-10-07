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

/**
 * The Snapshot select's choices for a sandbox node: "None", then the account's
 * active snapshots for the node's provider, pinned by provider image id. A pin
 * set in code that is not in the list still shows, so the select never hides
 * what the config holds.
 */
export function snapshotOptions(
  rows: ReadonlyArray<
    Pick<
      Doc<"sandboxSnapshots">,
      "name" | "provider" | "status" | "externalImageId"
    >
  >,
  provider: string,
  pinned: string | undefined,
): SnapshotOption[] {
  const options: SnapshotOption[] = [
    { value: "none", label: "None" },
    ...rows
      .filter((row) => row.provider === provider && row.status === "active")
      .map((row): SnapshotOption => ({
        value: row.externalImageId,
        label: row.name,
      })),
  ];
  if (pinned && !options.some((option) => option.value === pinned)) {
    options.push({ value: pinned, label: pinned });
  }

  return options;
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
