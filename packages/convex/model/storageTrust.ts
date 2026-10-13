/**
 * The trust a customer's own storage role gives Broods. Broods reaches every
 * customer role as one AWS principal, so the role's trust policy must also
 * require an sts:ExternalId that only this account's AssumeRole calls carry:
 * a random id Broods mints per account on first need and never lets a customer
 * set (the AWS confused-deputy guard). Mounts in core and file actions here
 * both send it; the dashboard and `GET /v1/account/storage-trust` show it.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { randomToken } from "./accountSecrets";
import { platformAwsAccountId } from "./workspaceRules";

/** Every assigned id starts with this, so a reader can tell whose it is. */
export const STORAGE_EXTERNAL_ID_PREFIX = "broods-";

export interface StorageTrust {
  /** The sts:ExternalId every AssumeRole of this account's roles carries. */
  externalId: string;
  /** The AWS principal the role must trust; absent on a stack with no AWS. */
  principalArn?: string;
  /** A ready-to-paste role trust policy naming both; absent without AWS. */
  trustPolicy?: string;
}

/**
 * The account's storage external id, minted and stored when it has none.
 * @throws when the account does not exist
 */
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

/**
 * What a customer puts on their role: the platform account as principal, with
 * the account's external id as a condition.
 */
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
