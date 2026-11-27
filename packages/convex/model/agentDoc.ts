import { v } from "convex/values";
import { agentsFields } from "../schema";

export const agentDoc = v.object({
  ...agentsFields,
  _id: v.id("agents"),
  _creationTime: v.number(),
});
