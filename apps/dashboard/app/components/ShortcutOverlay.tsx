"use client";

/**
 * The `?` sheet. Reads the same registry the dispatcher does, and dims what the
 * page you are on has not claimed, so the list is never a promise the app
 * cannot keep.
 */
import {
  useShortcut,
  useShortcutRegistry,
} from "@/app/components/ShortcutProvider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { scopeTitle, SHORTCUT_SCOPES, SHORTCUTS } from "@/app/lib/shortcuts";
import { ShortcutKeys } from "@/app/components/ShortcutKeys";
import { cn } from "@/app/lib/utils";
import { useState } from "react";

export function ShortcutOverlay(): React.JSX.Element {
  const { activeIds } = useShortcutRegistry();
  const [open, setOpen] = useState(false);

  useShortcut("help.open", () => setOpen(!open));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          {SHORTCUT_SCOPES.map((scope) => (
            <section key={scope} className="flex flex-col gap-1">
              <h3 className="text-2xs uppercase tracking-wide text-muted-foreground">
                {scopeTitle(scope)}
              </h3>
              {SHORTCUTS.filter((shortcut) => shortcut.scope === scope).map(
                (shortcut) => {
                  const isLive = activeIds.has(shortcut.id);

                  return (
                    <div
                      key={shortcut.id}
                      data-shortcut-row={shortcut.id}
                      data-live={isLive}
                      className={cn(
                        "flex items-center gap-3 text-xs",
                        isLive ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <ShortcutKeys
                        id={shortcut.id}
                        bordered
                        className="w-20 shrink-0"
                      />
                      <span className="min-w-0 truncate">{shortcut.label}</span>
                    </div>
                  );
                },
              )}
            </section>
          ))}
        </div>

        <p className="text-2xs text-muted-foreground">
          Dimmed rows belong to a surface that is not open right now.
        </p>
      </DialogContent>
    </Dialog>
  );
}
