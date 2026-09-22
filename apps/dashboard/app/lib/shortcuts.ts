/**
 * Every keyboard binding in the dashboard, in one list. The `?` overlay, the
 * hints the command palette prints on its rows, and the dispatcher in
 * `ShortcutProvider` all read this and nothing else.
 */

export type ShortcutScope = "global" | "canvas" | "panel" | "table";

export interface Shortcut {
  /** Accepted key combinations. The first is the one the overlay prints. */
  combos: readonly string[];
  id: string;
  label: string;
  scope: ShortcutScope;
}

/** Bindings a page registers; `global` ones work everywhere, the rest only where registered. */
export const SHORTCUTS = [
  {
    combos: ["mod+k"],
    id: "search.open",
    label: "Search everything",
    scope: "global",
  },
  {
    combos: ["mod+j"],
    id: "copilot.open",
    label: "Ask Broods",
    scope: "global",
  },
  {
    combos: ["?"],
    id: "help.open",
    label: "Keyboard shortcuts",
    scope: "global",
  },
  {
    combos: ["mod+p"],
    id: "project.switch",
    label: "Switch project",
    scope: "global",
  },
  {
    combos: ["mod+shift+s"],
    id: "stage.switch",
    label: "Switch stage",
    scope: "global",
  },
  { combos: ["["], id: "nav.prev", label: "Previous section", scope: "global" },
  { combos: ["]"], id: "nav.next", label: "Next section", scope: "global" },

  { combos: ["a"], id: "canvas.addAgent", label: "Add agent", scope: "canvas" },
  {
    combos: ["s"],
    id: "canvas.addSandbox",
    label: "Add sandbox",
    scope: "canvas",
  },
  {
    combos: ["w"],
    id: "canvas.addWorkspace",
    label: "Add workspace",
    scope: "canvas",
  },
  { combos: ["k"], id: "canvas.addSkill", label: "Add skill", scope: "canvas" },
  {
    combos: ["m"],
    id: "canvas.addMcp",
    label: "Add MCP server",
    scope: "canvas",
  },
  {
    combos: ["o"],
    id: "canvas.open",
    label: "Open selection",
    scope: "canvas",
  },
  {
    combos: ["enter"],
    id: "canvas.rename",
    label: "Rename selection",
    scope: "canvas",
  },
  {
    combos: ["g"],
    id: "canvas.group",
    label: "Group or pull out of group",
    scope: "canvas",
  },
  {
    combos: ["d"],
    id: "canvas.makeDefault",
    label: "Make default for its agent",
    scope: "canvas",
  },
  {
    combos: ["backspace", "delete"],
    id: "canvas.delete",
    label: "Delete selection",
    scope: "canvas",
  },
  { combos: ["f"], id: "canvas.fitView", label: "Fit view", scope: "canvas" },
  { combos: ["t"], id: "canvas.tidy", label: "Tidy up", scope: "canvas" },
  {
    combos: ["+", "="],
    id: "canvas.zoomIn",
    label: "Zoom in",
    scope: "canvas",
  },
  { combos: ["-"], id: "canvas.zoomOut", label: "Zoom out", scope: "canvas" },

  {
    combos: ["mod+b"],
    id: "panel.toggle",
    label: "Close side panel",
    scope: "panel",
  },
  {
    combos: ["1", "2", "3", "4", "5", "6"],
    id: "panel.tab",
    label: "Jump to panel tab",
    scope: "panel",
  },
  {
    combos: ["mod+enter"],
    id: "panel.send",
    label: "Send in Test tab",
    scope: "panel",
  },

  {
    combos: ["/"],
    id: "table.filter",
    label: "Focus the filter",
    scope: "table",
  },
  { combos: ["c"], id: "table.create", label: "New item", scope: "table" },
  { combos: ["r"], id: "table.refresh", label: "Refresh", scope: "table" },
] as const satisfies readonly Shortcut[];

/** Overlay section order. */
export const SHORTCUT_SCOPES: readonly ShortcutScope[] = [
  "global",
  "canvas",
  "panel",
  "table",
];

const SCOPE_TITLES: Record<ShortcutScope, string> = {
  canvas: "Architecture canvas",
  global: "Anywhere",
  panel: "Side panel",
  table: "Tables and lists",
};

/** How a combo token prints. Anything else prints uppercased. */
const TOKEN_GLYPHS: Record<string, string> = {
  alt: "⌥",
  backspace: "⌫",
  delete: "⌦",
  enter: "↵",
  escape: "esc",
  shift: "⇧",
};

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/**
 * The combo string a key event matches, in the same shape `SHORTCUTS` uses:
 * modifiers in a fixed order, then the key. `mod` is Command on a Mac and
 * Control everywhere else, so one entry covers both.
 */
export function eventCombo(event: KeyboardEvent, isMac: boolean): string {
  const key = event.key.toLowerCase();
  const parts: string[] = [];

  if (isMac ? event.metaKey : event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  // Only letters carry shift in a combo. Shift is what produces `?` and `+` in
  // the first place, so naming it there would never match.
  if (event.shiftKey && /^[a-z]$/.test(key)) parts.push("shift");
  parts.push(key);

  return parts.join("+");
}

/** A combo split into the tokens a `<kbd>` renders, one per key. */
export function formatCombo(combo: string, isMac: boolean): string[] {
  // "+" is both the separator and a key, so `"+"` splits into two empty
  // halves and `"mod++"` into one. Drop the empties and put a single `+` back.
  const parts = combo.split("+");
  const tokens = parts.filter((part) => part !== "");
  if (parts.at(-1) === "") tokens.push("+");

  return tokens.map((token) => {
    if (token === "mod") return isMac ? "⌘" : "Ctrl";

    return (
      TOKEN_GLYPHS[token] ?? (token.length === 1 ? token.toUpperCase() : token)
    );
  });
}

/** True while the event target takes text, where a bare letter is typing, not a command. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName;

  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

/** The shortcut a key event triggers, or undefined when the event is not one. */
export function matchShortcut(
  event: KeyboardEvent,
  isMac: boolean,
): Shortcut | undefined {
  const combo = eventCombo(event, isMac);

  return SHORTCUTS.find((shortcut) =>
    (shortcut.combos as readonly string[]).includes(combo),
  );
}

/** Section heading for a scope. */
export function scopeTitle(scope: ShortcutScope): string {
  return SCOPE_TITLES[scope];
}
