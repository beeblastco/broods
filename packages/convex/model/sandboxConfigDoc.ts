import { v } from "convex/values";
import { sandboxConfigsFields } from "../schema";

export const sandboxConfigDoc = v.object({
  ...sandboxConfigsFields,
  _id: v.id("sandboxConfigs"),
  _creationTime: v.number(),
});
