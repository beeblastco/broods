/**
 * Account tool and hook bundle cleanup. Bundle metadata lives in Convex while
 * the executable module bytes remain in account-prefixed S3 keys.
 */

import { requireEnv } from "../shared/env.ts";
import { deleteS3Prefix } from "../shared/s3.ts";

/** Deletes all custom-tool and hook bundle objects belonging to one account. */
export async function deleteAccountToolBundles(accountId: string): Promise<number> {
  const bucket = requireEnv("TOOL_BUNDLES_BUCKET_NAME");
  const encodedAccountId = encodeURIComponent(accountId);
  const [toolsDeleted, hooksDeleted] = await Promise.all([
    deleteS3Prefix(bucket, `account-tools/${encodedAccountId}/`),
    deleteS3Prefix(bucket, `account-hooks/${encodedAccountId}/`),
  ]);

  return toolsDeleted + hooksDeleted;
}
