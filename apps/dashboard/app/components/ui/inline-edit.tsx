"use client";

import { resolveInlineEdit } from "@/app/lib/inlineEdit";
import { cn } from "@/app/lib/utils";
import * as React from "react";

function InlineEdit({
  value,
  label,
  onCommit,
  onCancel,
  className,
}: {
  value: string;
  label: string;
  onCommit: (value: string) => void;
  /** Also called for a commit that changed nothing. */
  onCancel: () => void;
  className?: string;
}) {
  const [draft, setDraft] = React.useState(value);
  const [refused, setRefused] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  // Enter and Escape move focus away as the field closes; that blur must not commit again.
  const settledRef = React.useRef(false);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- focuses the DOM input before paint
  React.useLayoutEffect(() => {
    const active = document.activeElement;
    // Strict Mode runs this twice; the second pass finds the field focused.
    if (active instanceof HTMLElement && active !== inputRef.current) {
      returnFocusRef.current = active;
    }
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const close = (commit: string | null, returnFocus: boolean): void => {
    settledRef.current = true;
    // Before the callbacks, so a caller that moves focus itself has the last word.
    if (returnFocus && returnFocusRef.current?.isConnected) {
      returnFocusRef.current.focus({ preventScroll: true });
    }
    if (commit === null) onCancel();
    else onCommit(commit);
  };

  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label={label}
      aria-invalid={refused || undefined}
      autoComplete="off"
      dir="auto"
      data-slot="inline-edit"
      className={cn(
        "-my-px w-full min-w-0 flex-1 rounded-sm border border-primary bg-transparent px-1 py-0 shadow-xs outline-none selection:bg-primary selection:text-primary-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      onChange={(event) => {
        setDraft(event.target.value);
        setRefused(false);
      }}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          const outcome = resolveInlineEdit(draft, value);
          if (outcome.kind === "empty") setRefused(true);
          else close(outcome.kind === "commit" ? outcome.value : null, true);
        } else if (event.key === "Escape") {
          // Spent here, so the panel behind it does not close as well.
          event.preventDefault();
          close(null, true);
        }
      }}
      onBlur={() => {
        if (settledRef.current) return;
        const outcome = resolveInlineEdit(draft, value);
        close(outcome.kind === "commit" ? outcome.value : null, false);
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

export { InlineEdit };
