"use client";

import { cn } from "@/app/lib/utils";
import type { ComponentProps, ReactNode } from "react";

// The tallest bar stops here, so the label above it stays readable.
const BAR_MAX_PERCENT = 70;

/** One bar of the strip. */
export interface StripBar {
  key: string | number;
  /** 0 to 1, against the tallest bar. */
  height: number;
  /** The bar's background class, such as `bg-muted` or `bg-destructive/70`. */
  tone: string;
  title?: string;
  /** Faded, for a bar outside the current selection. */
  dimmed?: boolean;
}

/**
 * A row of thin bars with a label in the top right corner: the volume strip
 * under the Monitoring toolbar and the run history in a scheduler's panel
 * draw with it. Overlays such as a selection or a marker go in `children`;
 * pointer handlers and the ref come through the div props.
 */
export function BarStrip({
  bars,
  label,
  children,
  className,
  ...props
}: ComponentProps<"div"> & {
  bars: StripBar[];
  label: ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "relative flex h-9 shrink-0 items-end gap-px border-b border-border pt-1 select-none",
        className,
      )}
      {...props}
    >
      {bars.map((bar) => (
        <span
          key={bar.key}
          title={bar.title}
          style={{
            "--bar-height": `${Math.min(1, bar.height) * BAR_MAX_PERCENT}%`,
          }}
          className={cn(
            "h-(--bar-height) min-h-px flex-1",
            bar.tone,
            bar.dimmed && "opacity-30",
          )}
        />
      ))}
      {children}
      {/* A label may end at the client's clock, which the server render cannot know. */}
      <span
        suppressHydrationWarning
        className="pointer-events-none absolute top-0 right-3 font-mono text-3xs text-muted-foreground"
      >
        {label}
      </span>
    </div>
  );
}
