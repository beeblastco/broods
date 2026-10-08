"use client";

import { useShortcut } from "@/app/components/ShortcutProvider";
import { splitQueryChips } from "@/app/lib/queryTokens";
import { cn } from "@/app/lib/utils";
import { Search, X } from "lucide-react";
import { useRef } from "react";

interface Props {
  /** The whole query, chips included; the panels parse this one string. */
  value: string;
  onChange: (value: string) => void;
  /** Field names a `field:value` token may use; anything else stays free text. */
  fields: readonly string[];
  placeholder: string;
  className?: string;
}

/**
 * The toolbar's search box. A finished `field:value` token becomes a chip in
 * front of the text once a space follows it; Backspace on empty text pulls the
 * last chip back for editing, Escape clears everything, `/` focuses.
 */
export function SearchInput({
  value,
  onChange,
  fields,
  placeholder,
  className,
}: Props): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const { chips, text } = splitQueryChips(value, fields);

  useShortcut("table.filter", () => input.current?.focus());

  const emit = (nextChips: string[], nextText: string): void => {
    onChange(
      nextChips.length === 0 ? nextText : `${nextChips.join(" ")} ${nextText}`,
    );
  };

  const removeChip = (index: number): void => {
    emit(
      chips.filter((_, at) => at !== index),
      text,
    );
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape" && value !== "") {
      event.preventDefault();
      onChange("");
    } else if (event.key === "Backspace" && text === "" && chips.length > 0) {
      event.preventDefault();
      emit(chips.slice(0, -1), chips[chips.length - 1]);
    }
  };

  return (
    <label
      className={cn(
        "flex h-8 min-w-50 flex-1 cursor-text items-center gap-1 rounded-md border border-input bg-transparent px-2 text-xs dark:bg-input/30",
        "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50",
        className,
      )}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      {chips.map((chip, index) => (
        <span
          key={`${chip}-${index}`}
          className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 font-mono text-2xs text-foreground"
        >
          {chip}
          <button
            type="button"
            aria-label={`Remove ${chip}`}
            onClick={() => removeChip(index)}
            className="cursor-pointer text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={input}
        type="text"
        value={text}
        onChange={(event) => emit(chips, event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={chips.length === 0 ? placeholder : ""}
        aria-label="Search"
        className="min-w-16 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
      />
    </label>
  );
}
