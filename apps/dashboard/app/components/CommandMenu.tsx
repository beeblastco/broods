"use client";

/**
 * The live palette: `CommandPalette` with the project's own rows behind it.
 *
 * Rows come from `useDashboardIndex`, which reads Convex documents the app
 * already holds, so opening the palette costs no round trip.
 */
import { CommandPalette } from "@/app/components/CommandPalette";
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { useDashboardIndex } from "@/app/hooks/useDashboardIndex";
import { useStage } from "@/app/hooks/useStage";
import { itemAction } from "@/app/lib/copilotIntent";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useParams } from "next/navigation";

export function CommandMenu(): React.JSX.Element {
  const params = useParams<{ projectId?: string }>();
  const projectId = (params.projectId ?? null) as Id<"projects"> | null;
  const { stageId } = useStage();
  const { ask, runAction, setOpen: setCopilotOpen } = useCopilot();

  const items = useDashboardIndex(projectId, stageId);

  return (
    <CommandPalette
      items={items}
      onAsk={(query) => {
        setCopilotOpen(true);
        ask(query);
      }}
      onSelect={(item) => runAction(itemAction(item))}
    />
  );
}
