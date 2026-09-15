"use client";

import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** How long the check mark stays before the copy icon returns. */
const COPIED_MS = 1500;

interface Props {
  /** The text written to the clipboard. */
  value: string;
  /** What the button copies, for the accessible name. */
  label: string;
}

interface RowProps {
  /** The text written to the clipboard. */
  value: string;
  /** Sets the display (`flex`, `grid …`) and padding; the row has none of its own. */
  className: string;
  /** What the row shows; it also names the control, so `value` can truncate. */
  children: ReactNode;
}

/** Icon button that copies `value` and shows a check mark for a moment. */
export function CopyButton({ value, label }: Props): React.JSX.Element {
  const { copied, copy } = useCopied(value);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      tone="muted"
      aria-label={`Copy ${label}`}
      className="cursor-pointer"
      onClick={copy}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/**
 * A whole-row copy target: click anywhere on it to copy `value`. The copy icon
 * only shows on hover or keyboard focus, and the full value is the hover title,
 * so the row can truncate what it shows.
 */
export function CopyRow({
  value,
  className,
  children,
}: RowProps): React.JSX.Element {
  const { copied, copy } = useCopied(value);

  return (
    <button
      type="button"
      title={value}
      onClick={copy}
      className={cn(
        "group/copy min-w-0 max-w-full cursor-pointer items-center gap-2 rounded text-left transition-colors hover:bg-accent/40",
        className,
      )}
    >
      {children}
      {copied ? (
        <Check className="size-3 shrink-0 text-success" />
      ) : (
        <Copy className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100" />
      )}
    </button>
  );
}

// Clipboard write plus the short "copied" state, shown only once the write
// succeeded (a denied clipboard rejects). One timer per control: a second
// click restarts it, and unmount clears it so a closed panel does not set
// state later.
function useCopied(value: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function copy(): void {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => setCopied(false),
    );
  }

  return { copied: copied, copy: copy };
}
