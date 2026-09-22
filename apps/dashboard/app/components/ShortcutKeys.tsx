"use client";

/**
 * A binding's keys, as one `<kbd>` each, looked up by id so no caller has to
 * repeat a combo the registry already holds.
 *
 * The keys sit at the size of the label beside them, in the UI font. Below
 * that `⌫` and `↵` are a few pixels of stroke, and a monospace `O` is its own
 * problem: narrow enough to read as a zero.
 *
 * The server has no platform, so it prints the Ctrl glyphs and the client swaps
 * in the Command ones on hydration. Only the glyph differs, never the number of
 * keys, so each `<kbd>` carries `suppressHydrationWarning` and React replaces
 * the text without calling the page broken.
 */
import { useShortcutRegistry } from "@/app/components/ShortcutProvider";
import { formatCombo, SHORTCUTS, type ShortcutId } from "@/app/lib/shortcuts";
import { cn } from "@/app/lib/utils";

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
      {formatCombo(shortcut.combos[0], isMac).map((token, index) => (
        <kbd
          // The glyph is the only thing that varies, so the index is stable.
          key={index}
          suppressHydrationWarning
          className={cn(
            "text-xs text-foreground/80",
            bordered && "rounded-sm border border-border px-1",
          )}
        >
          {token}
        </kbd>
      ))}
    </span>
  );
}
