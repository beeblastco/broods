// A leaf so `agent/deployments` can use it without importing `account/accounts`, whose
// cascade imports `agent/deployments` back.

import { v } from "convex/values";
import { accountsFields } from "../schema";

export const accountDoc = v.object({
  ...accountsFields,
  _id: v.id("accounts"),
  _creationTime: v.number(),
});
