import {
  BroodsAccountApiError,
  type StorageTrust,
} from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

const ROLE_ARN = "arn:aws:iam::123456789012:role/broods-mount";

/**
 * Broods assigns the sts:ExternalId for an account's own storage roles: the
 * account reads one stable id (and its trust policy) through the gateway, and a
 * workspace that still names its own externalId is refused with a 400 that says
 * what to do. Assuming the role needs real AWS, so the id on the AssumeRole
 * call stays in the core and Convex unit tests.
 */
export async function storageTrust(context: VerifyContext): Promise<void> {
  const first = await context.measure(
    "storage trust read",
    (): Promise<StorageTrust> => context.account.getStorageTrust(),
  );
  const second = await context.account.getStorageTrust();
  assertStep(
    "the account's storage external id is Broods-assigned and stable",
    first.externalId.startsWith("broods-") &&
      first.externalId.length > 30 &&
      second.externalId === first.externalId,
    JSON.stringify([first, second]),
  );
  assertStep(
    "a trust policy, when shown, requires that id",
    first.trustPolicy === undefined ||
      first.trustPolicy.includes(`"sts:ExternalId": "${first.externalId}"`),
    String(first.trustPolicy),
  );

  // Not a fresh literal, so it type checks the way an old config reaches the API.
  const customerAuth = {
    type: "assumeRole" as const,
    roleArn: ROLE_ARN,
    externalId: "customer-picked",
  };
  let refusal = "";
  try {
    await context.account.createWorkspace({
      name: `external-id-${context.runId}`,
      config: {
        storage: {
          provider: "s3",
          bucket: `external-id-${context.runId}`,
          prefix: "agents/",
          auth: customerAuth,
        },
      },
    });
  } catch (error) {
    refusal =
      error instanceof BroodsAccountApiError
        ? `${error.status} ${error.message}`
        : String(error);
  }
  assertStep(
    "a workspace that sets its own externalId is a 400 naming the fix",
    refusal.startsWith("400") &&
      refusal.includes("config.storage.auth.externalId is no longer accepted"),
    refusal,
  );
}
