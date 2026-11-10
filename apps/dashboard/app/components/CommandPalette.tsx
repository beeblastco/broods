"use client";

// Takes its rows as props, so the `/ui-gallery` fixture drives it with no Convex behind it.
import { useShortcut } from "@/app/components/ShortcutProvider";
import { ShortcutKeys } from "@/app/components/ShortcutKeys";
import { useEverTrue } from "@/app/hooks/useEverTrue";
import { afterLoad } from "@/app/lib/prefetch";
import type { SearchGroup, SearchItem } from "@/app/lib/paletteSearch";
import { Search } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

const loadDialog = (): Promise<typeof import("./CommandPaletteDialog")> =>
  import("./CommandPaletteDialog");

const CommandPaletteDialog = lazy(() =>
  loadDialog().then((mod) => ({ default: mod.CommandPaletteDialog })),
);

export function CommandPalette({
  items,
  onAsk,
  onHighlight,
  onSelect,
  onWake,
}: {
  items: readonly SearchItem[];
  onAsk: (query: string) => void;
  onHighlight?: (item: SearchItem) => void;
  onSelect: (item: SearchItem) => void;
  onWake?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<SearchGroup | null>(null);
  const wanted = useEverTrue(open);

  const openScoped = (group: SearchGroup | null): void => {
    onWake?.();
    setQuery("");
    setOnly(group);
    setOpen(true);
  };
  const close = (): void => {
    setQuery("");
    setOnly(null);
    setOpen(false);
  };

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- warms the chunk after the load event
  useEffect(() => afterLoad(() => void loadDialog()), []);
  useShortcut("search.open", () => (open ? setOpen(false) : openScoped(null)));
  useShortcut("project.switch", () => openScoped("Projects"));
  useShortcut("stage.switch", () => openScoped("Stages"));

  return (
    <>
      <button
        type="button"
        data-palette-trigger
        aria-label="Search everything"
        onClick={() => openScoped(null)}
        onFocus={onWake}
        onPointerEnter={onWake}
        className="flex h-6.5 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2 text-muted-foreground transition-colors hover:text-foreground lg:w-56"
      >
        <Search className="size-3.5" />
        <span className="hidden text-xs lg:inline">Search</span>
        <ShortcutKeys id="search.open" className="ml-auto hidden lg:flex" />
      </button>

      {wanted && (
        <Suspense
          // Until the dialog arrives, typing lands in the query, not on a page shortcut.
          fallback={
            open && (
              <input
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the user just opened the palette
                autoFocus
                aria-label="Search everything"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  close();
                }}
                className="sr-only"
              />
            )
          }
        >
          <CommandPaletteDialog
            items={items}
            only={only}
            open={open}
            query={query}
            onAsk={onAsk}
            onClose={close}
            onHighlight={onHighlight}
            onOpenChange={setOpen}
            onQueryChange={setQuery}
            onSelect={onSelect}
          />
        </Suspense>
      )}
    </>
  );
}
