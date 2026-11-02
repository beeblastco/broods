import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { randomToken } from "./accountSecrets";
import { platformAwsAccountId } from "./workspaceRules";

export const STORAGE_EXTERNAL_ID_PREFIX = "broods-";

export interface StorageTrust {
  externalId: string;
  principalArn?: string;
  trustPolicy?: string;
}

// Every customer role trusts one Broods principal, so this per-account sts:ExternalId,
// which only Broods sets, is the confused-deputy guard: never let a customer choose it.
export async function ensureStorageExternalId(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<string> {
  const account = await ctx.db.get(accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);
  if (account.storageExternalId) return account.storageExternalId;
  const externalId = randomToken(STORAGE_EXTERNAL_ID_PREFIX, 24);
  await ctx.db.patch(accountId, { storageExternalId: externalId });

  return externalId;
}

export function storageTrust(externalId: string): StorageTrust {
  const platformAccountId = platformAwsAccountId();
  if (!platformAccountId) return { externalId: externalId };
  const principalArn = `arn:aws:iam::${platformAccountId}:root`;

  return {
    externalId: externalId,
    principalArn: principalArn,
    trustPolicy: JSON.stringify(
      {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: principalArn },
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "sts:ExternalId": externalId } },
          },
        ],
      },
      null,
      2,
    ),
  };
}
