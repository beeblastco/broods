"use client";

import { resolveInlineEdit } from "@/app/lib/inlineEdit";
import { cn } from "@/app/lib/utils";
import * as React from "react";

/**
 * A name edited where it is shown. Mount it in place of the text while a
 * rename is open: it takes focus with the caret at the end, Enter or blur
 * commits, Escape cancels, and Enter on a blank draft is refused. No border
 * or fill: it inherits the text's font and box, so only the caret shows the
 * edit. Enter and Escape hand focus back to the control that started it.
 */
function InlineEdit({
  value,
  label,
  onCommit,
  onCancel,
  className,
}: {
  /** The saved text: the draft starts from it, and committing it again changes nothing. */
  value: string;
  /** The field's accessible name. */
  label: string;
  /** A trimmed change; the caller closes the field and saves it. */
  onCommit: (value: string) => void;
  /** Cancelled, or committed with nothing changed; the caller closes the field. */
  onCancel: () => void;
  className?: string;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState(value);
  // The name when the field opened: a rename that lands meanwhile must not read as an edit.
  const [opened] = React.useState(value);
  const [refused, setRefused] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  // Enter and Escape move focus away as the field closes; that blur must not commit again.
  const settledRef = React.useRef(false);

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
      // A blank draft still shows what it was; refused, it turns red.
      placeholder={opened}
      data-slot="inline-edit"
      className={cn(
        "w-full min-w-0 flex-1 bg-transparent p-0 caret-primary outline-none selection:bg-primary/20",
        "placeholder:text-muted-foreground aria-invalid:caret-destructive aria-invalid:placeholder:text-destructive",
        className,
      )}
      onChange={(event) => {
        setDraft(event.target.value);
        setRefused(false);
      }}
      onFocus={(event) => {
        const end = event.currentTarget.value.length;
        event.currentTarget.setSelectionRange(end, end);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          const outcome = resolveInlineEdit(draft, opened);
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
        const outcome = resolveInlineEdit(draft, opened);
        close(outcome.kind === "commit" ? outcome.value : null, false);
      }}
      // Clicks in the field are not clicks on the row or card around it.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

export { InlineEdit };
