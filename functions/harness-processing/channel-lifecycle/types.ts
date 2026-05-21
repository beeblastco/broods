/**
 * Channel lifecycle component contracts.
 * Keep harness-owned extension hooks here; provider adapters stay in _shared.
 */

import type { SystemModelMessage, UserContent } from "ai";

export interface ChannelLifecycleContext {
  accountId?: string;
  agentId?: string;
  eventId: string;
  conversationKey: string;
  channelName: string;
  content: UserContent;
  source: Record<string, unknown>;
}

export interface ChannelHookResult {
  stop?: boolean;
  reason?: string;
  ephemeralSystem?: SystemModelMessage[];
}

export interface ChannelReplyResult {
  text: string;
}

export interface ChannelLifecycleComponent {
  readonly name: string;
  before?(context: ChannelLifecycleContext): Promise<ChannelHookResult | void>;
  after?(context: ChannelLifecycleContext, result: ChannelReplyResult): Promise<void>;
}
