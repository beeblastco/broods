"use client";

import { BroodsMark } from "@/app/components/BroodsMark";
import { useShortcutRegistry } from "@/app/components/ShortcutProvider";
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
  type RankedGroup,
  type SearchGroup,
  type SearchItem,
} from "@/app/lib/paletteSearch";
import { formatCombo, SHORTCUTS } from "@/app/lib/shortcuts";
import { useCommandState } from "cmdk";
import { useEffect, useMemo } from "react";

const HIGHLIGHT_SETTLE_MS = 120;

export interface CommandPaletteDialogProps {
  items: readonly SearchItem[];
  only: SearchGroup | null;
  open: boolean;
  query: string;
  onAsk: (query: string) => void;
  onClose: () => void;
  onHighlight?: (item: SearchItem) => void;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onSelect: (item: SearchItem) => void;
}

// Fetched the first time the palette opens: cmdk and its Radix dialog stay off the first load.
export function CommandPaletteDialog({
  items,
  only,
  open,
  query,
  onAsk,
  onClose,
  onHighlight,
  onOpenChange,
  onQueryChange,
  onSelect,
}: CommandPaletteDialogProps): React.JSX.Element {
  const { activeIds, isMac } = useShortcutRegistry();

  const actions = useMemo(
    () =>
      SHORTCUTS.filter((shortcut) => activeIds.has(shortcut.id)).map(
        (shortcut): SearchItem => ({
          detail: formatCombo(shortcut.combos[0], isMac).join(" "),
          group: "Actions",
          id: `action:${shortcut.id}`,
          keywords: [shortcut.scope, ...(shortcut.keywords ?? [])],
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
    onClose();
    onSelect(item);
  };

  const handOff = (): void => {
    const asked = query;
    onClose();
    onAsk(asked);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search everything"
      description="Find a node, a cron, a variable, a page, or run a command."
      shouldFilter={false}
    >
      <CommandInput
        value={query}
        onValueChange={onQueryChange}
        placeholder={
          only
            ? `Switch ${only.toLowerCase().replace(/s$/, "")}...`
            : "Search nodes, crons, variables, pages, actions..."
        }
      />
      {onHighlight && (
        <HighlightWatch groups={groups} onHighlight={onHighlight} />
      )}
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
              <BroodsMark className="size-3.5" />
              <span className="truncate">Ask Broods agent: {query.trim()}</span>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

function HighlightWatch({
  groups,
  onHighlight,
}: {
  groups: readonly RankedGroup[];
  onHighlight: (item: SearchItem) => void;
}): null {
  const value = useCommandState((state) => state.value);
  const item = useMemo(
    () =>
      groups.flatMap((group) => group.items).find((row) => row.id === value),
    [groups, value],
  );

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- settle timer on cmdk's highlight
  useEffect(() => {
    if (!item) return;
    const id = window.setTimeout(() => onHighlight(item), HIGHLIGHT_SETTLE_MS);

    return () => window.clearTimeout(id);
  }, [item, onHighlight]);

  return null;
}
