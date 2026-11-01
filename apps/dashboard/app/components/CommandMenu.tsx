"use client";

/**
 * The live palette: `CommandPalette` with the project's own rows behind it.
 *
 * Rows are the copilot's index, so the palette and the dock share one set of
 * subscriptions. Hovering or focusing the trigger wakes them, which puts the
 * rows on their way before the click opens the dialog. A row that leads to a
 * page starts that page once it is highlighted, ahead of the Enter.
 */
import { CommandPalette } from "@/app/components/CommandPalette";
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { useRouteIntent } from "@/app/hooks/useRouteIntent";
import { itemAction } from "@/app/lib/copilotIntent";
import type { SearchItem } from "@/app/lib/paletteSearch";
import { useCallback } from "react";

export function CommandMenu(): React.JSX.Element {
  const {
    ask,
    items,
    runAction,
    setOpen: setCopilotOpen,
    wakeIndex,
  } = useCopilot();
  const { warm } = useRouteIntent();
  const warmRow = useCallback(
    (item: SearchItem): void => {
      if (item.target.type === "navigate") warm(item.target.href);
    },
    [warm],
  );

  return (
    <CommandPalette
      items={items}
      onAsk={(query) => {
        setCopilotOpen(true);
        ask(query);
      }}
      onHighlight={warmRow}
      onSelect={(item) => runAction(itemAction(item))}
      onWake={wakeIndex}
    />
  );
}
