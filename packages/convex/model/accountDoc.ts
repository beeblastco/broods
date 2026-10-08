/**
 * The `accounts` row as functions return it. A leaf of its own so
 * `agent/deployments` can name it without importing `account/accounts`,
 * whose cascade reaches `stage`, which reaches `agent/deployments` again.
 */

import { v } from "convex/values";
import { accountsFields } from "../schema";

export const accountDoc = v.object({
  ...accountsFields,
  _id: v.id("accounts"),
  _creationTime: v.number(),
});
