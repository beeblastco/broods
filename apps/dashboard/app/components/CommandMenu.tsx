"use client";

/**
 * The live palette: `CommandPalette` with the project's own rows behind it.
 *
 * Rows are the copilot's index, so the palette and the dock share one set of
 * subscriptions. Hovering or focusing the trigger wakes them, which puts the
 * rows on their way before the click opens the dialog.
 */
import { CommandPalette } from "@/app/components/CommandPalette";
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { itemAction } from "@/app/lib/copilotIntent";

export function CommandMenu(): React.JSX.Element {
  const {
    ask,
    items,
    runAction,
    setOpen: setCopilotOpen,
    wakeIndex,
  } = useCopilot();

  return (
    <CommandPalette
      items={items}
      onAsk={(query) => {
        setCopilotOpen(true);
        ask(query);
      }}
      onSelect={(item) => runAction(itemAction(item))}
      onWake={wakeIndex}
    />
  );
}
