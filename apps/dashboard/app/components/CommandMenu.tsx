"use client";

/**
 * Search everything, run anything, or hand the query to Broods.
 *
 * Rows come from `useDashboardIndex` (Convex documents the app already holds)
 * plus every shortcut the current page has claimed, so an action appears here
 * the moment some component binds it and disappears when that page unmounts.
 */
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
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
import { useDashboardIndex } from "@/app/hooks/useDashboardIndex";
import { useStage } from "@/app/hooks/useStage";
import { itemAction } from "@/app/lib/copilotIntent";
import {
  rankItems,
  type SearchGroup,
  type SearchItem,
} from "@/app/lib/paletteSearch";
import { formatCombo, SHORTCUTS } from "@/app/lib/shortcuts";
import type { Id } from "@broods/convex/_generated/dataModel";
import { Search, Sparkles } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";

export function CommandMenu(): React.JSX.Element {
  const params = useParams<{ projectId?: string }>();
  const projectId = (params.projectId ?? null) as Id<"projects"> | null;
  const { stageId } = useStage();
  const { activeIds, isMac } = useShortcutRegistry();
  const { ask, runAction, setOpen: setCopilotOpen } = useCopilot();

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

  const indexed = useDashboardIndex(projectId, stageId);

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
    const ranked = rankItems([...indexed, ...actions], query);

    return only ? ranked.filter((group) => group.group === only) : ranked;
  }, [actions, indexed, only, query]);

  const select = (item: SearchItem): void => {
    openScoped(null);
    setOpen(false);
    runAction(itemAction(item));
  };

  const handOff = (): void => {
    const asked = query;
    openScoped(null);
    setOpen(false);
    setCopilotOpen(true);
    ask(asked);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-6.5 w-56 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Search className="size-3.5" />
        <span className="text-xs">Search</span>
        <span className="ml-auto flex items-center gap-0.5">
          {formatCombo("mod+k", isMac).map((token) => (
            <kbd key={token} className="text-3xs">
              {token}
            </kbd>
          ))}
        </span>
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
                <Sparkles className="text-canvas-agent" />
                <span className="truncate">Ask Broods: {query.trim()}</span>
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
