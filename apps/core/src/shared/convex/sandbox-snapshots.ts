import type { SandboxScope } from "@broods/convex/model/sandboxRules";
import type { SandboxProvider } from "../domain/sandbox-config.ts";
import { adminMutation, adminQuery, internal } from "./client.ts";

// Keep in step with sandboxSnapshotsFields.status in the Convex schema.
export type SandboxSnapshotStatus =
  | "pending"
  | "building"
  | "pulling"
  | "active"
  | "inactive"
  | "error"
  | "build_failed";

export interface SandboxSnapshotRecord {
  accountId: string;
  scope?: SandboxScope;
  baseImage: string;
  status: SandboxSnapshotStatus;
}

// Null when no account registered the image: a provider image, not a Broods snapshot.
export async function findSandboxSnapshot(
  accountId: string | undefined,
  externalImageId: string,
): Promise<SandboxSnapshotRecord | null> {
  return adminQuery(internal.sandbox.snapshots.findByImage, {
    ...(accountId ? { accountId: accountId } : {}),
    externalImageId: externalImageId,
  });
}

// Throws on failure: the row locks the image to its stage, so an unrecorded capture fails.
export async function upsertSandboxSnapshot(input: {
  accountId: string;
  scope: SandboxScope;
  name: string;
  provider: SandboxProvider;
  baseImage: string;
  externalImageId: string;
  status?: SandboxSnapshotStatus;
}): Promise<void> {
  await adminMutation(internal.sandbox.snapshots.upsert, {
    accountId: input.accountId,
    scope: input.scope,
    name: input.name,
    provider: input.provider,
    baseImage: input.baseImage,
    externalImageId: input.externalImageId,
    ...(input.status ? { status: input.status } : {}),
  });
}
