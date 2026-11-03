"use client";

import { IconTooltip } from "@/app/components/IconTooltip";
import { memo } from "react";

// Memoised: the usage row re-renders on every tween frame, and the text never changes.
export const HelpMark = memo(function HelpMark({
  text,
}: {
  text: string;
}): React.JSX.Element {
  return (
    <IconTooltip label={text}>
      <button
        type="button"
        className="cursor-help text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        ?
      </button>
    </IconTooltip>
  );
});
