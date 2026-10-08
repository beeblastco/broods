"use client";

import { cn } from "@/app/lib/utils";

export interface SegmentedOption<T extends string> {
  id: T;
  label?: string;
  /** Shown after the label in mono, for status counts. */
  count?: number;
}

/**
 * A row of exclusive buttons in one frame: the time range on list pages, the
 * status counts on the sandbox list. One is always pressed.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}): React.JSX.Element {
  return (
    <fieldset
      aria-label={ariaLabel}
      className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "cursor-pointer rounded px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
            value === option.id
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label ?? option.id}
          {option.count !== undefined && (
            <span className="ml-1 font-mono text-2xs tabular-nums opacity-80">
              {option.count.toLocaleString()}
            </span>
          )}
        </button>
      ))}
    </fieldset>
  );
}
