import { isDeepStrictEqual } from "node:util";
import {
  BroodsAccountApiError,
  type AccountWorkspace,
} from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

const R2_STORAGE = {
  provider: "s3" as const,
  bucket: "agent-files",
  prefix: "broods/",
  endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  auth: {
    type: "r2" as const,
    accessKeyId: "${R2_ACCESS_KEY_ID}",
    secretAccessKey: "${R2_SECRET_ACCESS_KEY}",
  },
};

/**
 * An R2 workspace saves through the gateway with its keys as env refs and comes
 * back holding only the refs; a literal key is refused. Minting needs a real R2
 * bucket, so it stays in the Convex and core unit tests.
 */
export async function r2Workspace(context: VerifyContext): Promise<void> {
  const workspace = await context.measure(
    "r2 workspace create",
    (): Promise<AccountWorkspace> =>
      context.account.createWorkspace({
        name: `r2-${context.runId}`,
        config: { storage: R2_STORAGE },
      }),
  );
  assertStep(
    "an R2 workspace stores env refs, never key values",
    isDeepStrictEqual(workspace.config.storage, R2_STORAGE),
    JSON.stringify(workspace.config.storage),
  );
  await context.account.deleteWorkspace(workspace.workspaceId);

  let status = 0;
  try {
    await context.account.createWorkspace({
      name: `r2-inline-${context.runId}`,
      config: {
        storage: {
          ...R2_STORAGE,
          auth: { ...R2_STORAGE.auth, secretAccessKey: "inline-secret" },
        },
      },
    });
  } catch (error) {
    status = error instanceof BroodsAccountApiError ? error.status : -1;
  }
  assertStep(
    "an R2 workspace with a literal key is a 400",
    status === 400,
    String(status),
  );
}
