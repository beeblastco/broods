import type { Doc } from "@broods/convex/_generated/dataModel";

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
