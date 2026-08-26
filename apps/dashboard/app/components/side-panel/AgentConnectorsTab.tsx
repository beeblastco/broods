"use client";

/**
 * Connectors tab (ticket 16). Two groups: Channels — the relocated
 * ChannelsSection, same encrypted config write path it had in Details — and
 * Connectors, an honest empty state until tickets 19/20 make services and
 * MCP servers connectable.
 */

import { ChannelsSection } from "@/app/components/side-panel/ChannelsSection";
import { Separator } from "@/app/components/ui/separator";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { Plug } from "lucide-react";

export function AgentConnectorsTab({
  agentConfig,
  onUpdateChannelConfig,
}: {
  agentConfig: Doc<"agentConfigs"> | null | undefined;
  onUpdateChannelConfig?: (
    kind: string,
    config: Record<string, unknown> | null,
  ) => Promise<void>;
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-5 p-4">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Channels
        </span>
        <p className="text-[11px] text-muted-foreground">
          Places people can message this agent — Telegram, Slack, Discord and
          more. Configure one and the agent answers there.
        </p>
      </div>
      {agentConfig && onUpdateChannelConfig ? (
        <ChannelsSection
          agentConfig={agentConfig}
          onUpdateChannel={onUpdateChannelConfig}
        />
      ) : (
        <p className="text-xs text-muted-foreground">Loading channels…</p>
      )}

      <Separator />

      <div className="flex flex-col gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Connectors
        </span>
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/30 px-3 py-4">
          <Plug className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            No connectors yet — you&apos;ll be able to connect services and MCP
            servers here, so the agent can act on your other tools.
          </p>
        </div>
      </div>
    </div>
  );
}
