"use client";

import { IconTooltip } from "@/app/components/IconTooltip";

/**
 * A "?" after a label whose number needs a sentence: hover or focus it to
 * read what the value is counted from. Its click, Enter and Space stay here
 * so they never also pick the row it sits in; other keys still reach the
 * dashboard's shortcuts.
 */
export function HelpMark({ text }: { text: string }): React.JSX.Element {
  return (
    <IconTooltip label={text}>
      <button
        type="button"
        className="cursor-help text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ")
            event.stopPropagation();
        }}
      >
        ?
      </button>
    </IconTooltip>
  );
}
