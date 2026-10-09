"use client";

import { IconTooltip } from "@/app/components/IconTooltip";
import { memo } from "react";

/**
 * A "?" after a label whose number needs a sentence: hover or focus it to
 * read what the value is counted from. Its click stays here so it never
 * also picks the row it sits in. Memoised: the usage numbers row re-renders
 * every frame of its tween, and the text never changes.
 */
export const HelpMark = memo(function HelpMark({
  text,
}: {
  text: string;
}): React.JSX.Element {
  return (
    <IconTooltip label={text}>
      <button
        type="button"
        className="ml-1 cursor-help text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        ?
      </button>
    </IconTooltip>
  );
});
