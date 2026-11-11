"use client";

import { IconTooltip } from "@/app/components/IconTooltip";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Eye, EyeOff } from "lucide-react";
import { useState, type ComponentProps } from "react";

// A secret typed by hand: masked until shown, never autofilled, spellchecked or corrected.
// `className` sizes the input; `noun` names the toggle ("Show key").
export function SecretInput({
  noun,
  ...props
}: Omit<ComponentProps<"input">, "type"> & {
  noun: string;
}): React.JSX.Element {
  const [shown, setShown] = useState(false);
  const toggleLabel = `${shown ? "Hide" : "Show"} ${noun}`;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <Input
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="none"
        {...props}
      />
      <IconTooltip label={toggleLabel}>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="shrink-0 cursor-pointer"
          onClick={() => setShown(!shown)}
        >
          {shown ? (
            <EyeOff className="size-3.5" />
          ) : (
            <Eye className="size-3.5" />
          )}
        </Button>
      </IconTooltip>
    </div>
  );
}
