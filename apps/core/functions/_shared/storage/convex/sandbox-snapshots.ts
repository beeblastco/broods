/**
 * Convex mirror writes for sandbox snapshot/image build state. The account-manage
 * snapshot endpoint calls this after the provider captures a snapshot so the
 * dashboard's live sandboxSnapshots query reflects it. Fire-and-forget safe —
 * gated on convex mode and wrapped so a mirror failure never fails the request.
 * See usage.ts for the same pattern.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const internal: any = require("@broods/convex/_generated/api").internal;
import { getConvexClient } from "./client.ts";
import { logError } from "../../log.ts";
import type { SandboxProvider } from "../sandbox-config.ts";

/** Unified (Daytona-aligned) snapshot build status; mirrors sandboxSnapshotsFields.status. */
export type SandboxSnapshotStatus =
  | "pending"
  | "building"
  | "pulling"
  | "active"
  | "inactive"
  | "error"
  | "build_failed";

/** Convex mode is active only when both env vars are present (see CLAUDE.md). */
function convexEnabled(): boolean {
  return Boolean(process.env.CONVEX_URL && process.env.CONVEX_DEPLOY_KEY);
}

/**
 * Mirrors a captured/registered snapshot into Convex. No-op outside convex mode.
 * Idempotent by (account, name).
 */
export async function upsertSandboxSnapshot(input: {
  accountId: string;
  name: string;
  provider: SandboxProvider;
  baseImage: string;
  externalImageId: string;
  status?: SandboxSnapshotStatus;
}): Promise<void> {
  if (!convexEnabled()) return;
  try {
    await getConvexClient().mutation(internal.sandboxSnapshots.upsert, {
      accountId: input.accountId as any,
      name: input.name,
      provider: input.provider,
      baseImage: input.baseImage,
      externalImageId: input.externalImageId,
      ...(input.status ? { status: input.status } : {}),
    });
  } catch (err) {
    logError("Sandbox snapshot mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
