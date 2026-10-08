"use client";

import { CopyButton } from "@/app/components/CopyButton";
import { Textarea } from "@/app/components/ui/textarea";

/**
 * A read-only text box with its copy button pinned to the top-right corner.
 * The user can drag it taller up to a limit; past that it scrolls, and the
 * button stays put. The button shows while the pointer is in the box or the
 * box has focus.
 */
export function CopyTextarea({
  value,
  label,
  code = false,
}: {
  value: string;
  /** What the copy button copies, for its accessible name. */
  label: string;
  /** Monospace, for expressions and config. */
  code?: boolean;
}): React.JSX.Element {
  return (
    <div className="group/copy relative">
      <Textarea
        readOnly
        value={value}
        aria-label={label}
        variant={code ? "code" : "default"}
        className="max-h-80 min-h-24 resize-y text-xs"
      />
      <span className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-focus-within/copy:opacity-100 group-hover/copy:opacity-100">
        <CopyButton value={value} label={label} />
      </span>
    </div>
  );
}
