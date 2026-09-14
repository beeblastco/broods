"use client";

import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";

/** How long the check mark stays before the copy icon returns. */
const COPIED_MS = 1500;

interface Props {
  /** The text written to the clipboard. */
  value: string;
  /** What the button copies, for the accessible name. */
  label: string;
}

interface RowProps extends Props {
  className?: string;
  /** What the row shows; `value` is what it copies. */
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
      aria-label={`Copy ${label}`}
      className="cursor-pointer text-muted-foreground"
      onClick={copy}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/**
 * A whole-row copy target: click anywhere on it to copy `value`. The copy icon
 * only shows on hover, and the full value is the hover title, so the row can
 * truncate what it shows.
 */
export function CopyRow({
  value,
  label,
  className,
  children,
}: RowProps): React.JSX.Element {
  const { copied, copy } = useCopied(value);

  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={value}
      onClick={copy}
      className={cn(
        "group/copy flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded text-left transition-colors hover:bg-accent/40",
        className,
      )}
    >
      {children}
      {copied ? (
        <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Copy className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/copy:opacity-100" />
      )}
    </button>
  );
}

/** Clipboard write plus the short "copied" state both copy controls show. */
export function useCopied(value: string): {
  copied: boolean;
  copy: () => void;
} {
  const [copied, setCopied] = useState(false);

  function copy(): void {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  }

  return { copied: copied, copy: copy };
}
