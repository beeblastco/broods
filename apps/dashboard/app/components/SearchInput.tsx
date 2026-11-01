"use client";

import { useShortcut } from "@/app/components/ShortcutProvider";
import { splitQueryChips } from "@/app/lib/queryTokens";
import { cn } from "@/app/lib/utils";
import { Search, X } from "lucide-react";
import { useId, useRef } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  fields: readonly string[];
  placeholder: string;
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  fields,
  placeholder,
  className,
}: Props): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  // Without htmlFor, a click on the box would activate a chip's remove button, also labelable.
  const inputId = useId();
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
      htmlFor={inputId}
      className={cn(
        "flex h-8 min-w-50 flex-1 cursor-text items-center gap-1 overflow-x-auto rounded-md border border-input bg-transparent px-2 text-xs dark:bg-input/30",
        "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50",
        className,
      )}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      {chips.map((chip, index) => (
        <span
          // oxlint-disable-next-line react/no-array-index-key -- chips may repeat in a query
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
        id={inputId}
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
