/**
 * What a forwarder reads from `channel/connections:listConnections`. A leaf
 * module, so the forwarders can import the type without typechecking the rest
 * of the config plane.
 */

import { v, type Infer } from "convex/values";

export const channelConnectionValidator = v.object({
  agentId: v.string(),
  agentName: v.string(),
  /** The channel's API base URL, when set. Matrix always sets its homeserver. */
  apiUrl: v.optional(v.string()),
  botToken: v.string(),
  /**
   * Path only. The caller joins it onto its own configured base URL, so the
   * config plane never has to know which gateway front door is in front of it.
   */
  webhookPath: v.string(),
});

export type ChannelConnection = Infer<typeof channelConnectionValidator>;
