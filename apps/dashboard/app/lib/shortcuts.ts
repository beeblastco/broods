export type ShortcutScope = "global" | "canvas" | "panel" | "table";

export interface Shortcut {
  /** The first combo is the one the overlay prints. */
  combos: readonly string[];
  id: string;
  keywords?: readonly string[];
  label: string;
  scope: ShortcutScope;
}

export type ShortcutId = (typeof SHORTCUT_DEFS)[number]["id"];

const SHORTCUT_DEFS = [
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
  {
    combos: ["mod+b"],
    id: "sidebar.toggle",
    label: "Toggle sidebar",
    scope: "global",
  },

  {
    combos: ["a"],
    id: "canvas.addAgent",
    keywords: ["config"],
    label: "Add agent",
    scope: "canvas",
  },
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
    combos: ["escape"],
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
  {
    combos: ["`"],
    id: "sandbox.terminal",
    label: "Toggle the terminal",
    scope: "table",
  },
] as const;

export const SHORTCUTS: readonly (Shortcut & { id: ShortcutId })[] =
  SHORTCUT_DEFS;

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

const TOKEN_GLYPHS: Record<string, string> = {
  alt: "⌥",
  backspace: "⌫",
  delete: "⌦",
  enter: "↵",
  escape: "esc",
  shift: "⇧",
};

// Enter and Space click a focused button or follow a link: a bare binding must not eat them.
export function activatesFocusedControl(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" && event.key !== " ") return false;

  return (
    event.target instanceof HTMLElement &&
    event.target.closest("a[href],button,[role=button],summary") !== null
  );
}

export function eventCombo(event: KeyboardEvent, isMac: boolean): string {
  const key = event.key.toLowerCase();
  const parts: string[] = [];

  if (isMac ? event.metaKey : event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  // Only letters carry shift: shift is what produces `?` and `+`, so naming it never matches.
  if (event.shiftKey && /^[a-z]$/.test(key)) parts.push("shift");
  parts.push(key);

  return parts.join("+");
}

export function formatCombo(combo: string, isMac: boolean): string[] {
  // "+" is both separator and key: `"+"` splits into two empty halves, `"mod++"` into one.
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

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName;

  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

export function matchShortcut(
  event: KeyboardEvent,
  isMac: boolean,
): Shortcut | undefined {
  const combo = eventCombo(event, isMac);

  return SHORTCUTS.find((shortcut) => shortcut.combos.includes(combo));
}

export function scopeTitle(scope: ShortcutScope): string {
  return SCOPE_TITLES[scope];
}
