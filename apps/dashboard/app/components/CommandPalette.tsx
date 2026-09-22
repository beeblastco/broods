"use client";

/**
 * Search everything, run anything, or hand the query to Broods.
 *
 * Takes its rows rather than fetching them, so the `/ui-gallery` fixture can
 * drive the real dialog, the real ranking and the real bindings with no Convex
 * behind it. `CommandMenu` is the wrapper that supplies the live index.
 */
import {
  useShortcut,
  useShortcutRegistry,
} from "@/app/components/ShortcutProvider";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/app/components/ui/command";
import {
  rankItems,
  type SearchGroup,
  type SearchItem,
} from "@/app/lib/paletteSearch";
import { formatCombo, SHORTCUTS } from "@/app/lib/shortcuts";
import { ShortcutKeys } from "@/app/components/ShortcutKeys";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

export function CommandPalette({
  items,
  onAsk,
  onSelect,
}: {
  items: readonly SearchItem[];
  onAsk: (query: string) => void;
  onSelect: (item: SearchItem) => void;
}): React.JSX.Element {
  const { activeIds, isMac } = useShortcutRegistry();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Switching project or stage is the same list with one heading left standing,
  // which is cheaper than three dropdowns that each need controlled open state.
  const [only, setOnly] = useState<SearchGroup | null>(null);

  const openScoped = (group: SearchGroup | null): void => {
    setQuery("");
    setOnly(group);
    setOpen(true);
  };

  useShortcut("search.open", () => (open ? setOpen(false) : openScoped(null)));
  useShortcut("project.switch", () => openScoped("Projects"));
  useShortcut("stage.switch", () => openScoped("Stages"));

  // Every claimed binding is a row, labelled and shortcut-hinted from the one
  // registry, so the palette teaches the keyboard map by being used.
  const actions = useMemo(
    () =>
      SHORTCUTS.filter((shortcut) => activeIds.has(shortcut.id)).map(
        (shortcut): SearchItem => ({
          detail: formatCombo(shortcut.combos[0], isMac).join(" "),
          group: "Actions",
          id: `action:${shortcut.id}`,
          keywords: [shortcut.scope],
          target: { commandId: shortcut.id, type: "command" },
          title: shortcut.label,
        }),
      ),
    [activeIds, isMac],
  );

  const groups = useMemo(() => {
    const ranked = rankItems([...items, ...actions], query);

    return only ? ranked.filter((group) => group.group === only) : ranked;
  }, [actions, items, only, query]);

  const select = (item: SearchItem): void => {
    openScoped(null);
    setOpen(false);
    onSelect(item);
  };

  const handOff = (): void => {
    const asked = query;
    openScoped(null);
    setOpen(false);
    onAsk(asked);
  };

  return (
    <>
      <button
        type="button"
        data-palette-trigger
        onClick={() => openScoped(null)}
        className="flex h-6.5 w-56 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Search className="size-3.5" />
        <span className="text-xs">Search</span>
        <ShortcutKeys id="search.open" className="ml-auto" />
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search everything"
        description="Find a node, a cron, a variable, a page, or run a command."
        shouldFilter={false}
      >
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={
            only
              ? `Switch ${only.toLowerCase().replace(/s$/, "")}...`
              : "Search nodes, crons, variables, pages, actions..."
          }
        />
        <CommandList>
          {groups.length === 0 && (
            <CommandEmpty>Nothing here matches.</CommandEmpty>
          )}
          {groups.map((group) => (
            <CommandGroup key={group.group} heading={group.group}>
              {group.items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  onSelect={() => select(item)}
                >
                  <span className="truncate">{item.title}</span>
                  {item.detail && (
                    <span className="ml-auto pl-2 text-2xs text-muted-foreground">
                      {item.detail}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {query.trim() && !only && (
            <CommandGroup heading="Ask">
              <CommandItem value="ask-broods" onSelect={handOff}>
                <span className="truncate">Ask Broods: {query.trim()}</span>
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
