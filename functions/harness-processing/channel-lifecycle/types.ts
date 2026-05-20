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

export interface ChannelLifecycleDecision {
  shouldContinue: boolean;
  reason?: string;
}

export interface ChannelLifecycleContextResult {
  canReply: boolean;
  system?: SystemModelMessage[];
  reason?: string;
}

export interface ChannelLifecycleComponent {
  readonly name: string;
  prepareMessage?(context: ChannelLifecycleContext): Promise<ChannelLifecycleDecision>;
  loadContext?(context: ChannelLifecycleContext): Promise<ChannelLifecycleContextResult>;
  recordReply?(context: ChannelLifecycleContext, responseText: string): Promise<void>;
}
