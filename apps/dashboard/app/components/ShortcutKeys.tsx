"use client";

import {
  ArrowBigUp,
  CornerDownLeft,
  Delete,
  Option,
  type LucideIcon,
} from "lucide-react";
import { useShortcutRegistry } from "@/app/components/ShortcutProvider";
import { formatCombo, SHORTCUTS, type ShortcutId } from "@/app/lib/shortcuts";
import { cn } from "@/app/lib/utils";

// No `⌘`: it swaps in for the server's Ctrl on hydration, which only text may do.
const GLYPH_ICONS: Record<string, { icon: LucideIcon; name: string }> = {
  "↵": { icon: CornerDownLeft, name: "Return" },
  "⇧": { icon: ArrowBigUp, name: "Shift" },
  "⌥": { icon: Option, name: "Option" },
  "⌫": { icon: Delete, name: "Backspace" },
};

export function ShortcutKeys({
  bordered = false,
  className,
  id,
}: {
  bordered?: boolean;
  className?: string;
  id: ShortcutId;
}): React.JSX.Element | null {
  const { isMac } = useShortcutRegistry();
  const shortcut = SHORTCUTS.find((entry) => entry.id === id);
  if (!shortcut) return null;

  return (
    <span className={cn("flex items-center gap-1", className)}>
      {formatCombo(shortcut.combos[0], isMac).map((token, index) => {
        const glyph = GLYPH_ICONS[token];

        return (
          <kbd
            // oxlint-disable-next-line react/no-array-index-key -- a combo's keys are positional
            key={index}
            suppressHydrationWarning
            aria-label={glyph?.name}
            className={cn(
              "flex items-center justify-center",
              bordered
                ? "rounded-sm border border-border px-1 text-xs text-foreground/80"
                : "min-w-4 text-sm text-muted-foreground",
            )}
          >
            {glyph ? (
              <glyph.icon className={bordered ? "size-3" : "size-4"} />
            ) : (
              token
            )}
          </kbd>
        );
      })}
    </span>
  );
}
