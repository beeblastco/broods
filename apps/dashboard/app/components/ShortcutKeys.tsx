"use client";

/**
 * A binding's keys, as one `<kbd>` each, looked up by id so no caller has to
 * repeat a combo the registry already holds.
 *
 * Bare hints sit in menu rows, so they match the row's leading icon: symbol
 * keys draw as lucide icons at 16px and letters at the label's 14px, all in
 * the row icon's grey. As font glyphs `⌫` and `↵` were a few pixels of stroke.
 * An icon's `<kbd>` carries the key's name as its label.
 *
 * The server has no platform, so it prints the Ctrl glyphs and the client swaps
 * in the Command ones on hydration. Only the glyph differs, never the number of
 * keys, so each `<kbd>` carries `suppressHydrationWarning` and React replaces
 * the text without calling the page broken. That swap is text only, which is
 * why `⌘` stays a glyph and never becomes an icon.
 */
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

/** Glyphs from `formatCombo` that draw as an icon, with the key they name. */
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
            // The glyph is the only thing that varies, so the index is stable.
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
