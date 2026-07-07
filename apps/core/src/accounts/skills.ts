/**
 * Account skill cleanup. Skill CRUD moved to the Convex config plane
 * (packages/convex/configHttp.ts, epic #85 phase 9); core keeps only the
 * account-deletion sweep here and the runtime read path in shared/skills.
 */

import { deleteS3Prefix } from "../shared/s3.ts";
import { skillsBucketName } from "../shared/skills.ts";

export async function deleteAccountSkills(accountId: string): Promise<number> {
  return deleteS3Prefix(skillsBucketName(), `${accountId}/`);
}
