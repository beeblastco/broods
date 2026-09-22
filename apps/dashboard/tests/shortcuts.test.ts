import { describe, expect, test } from "bun:test";
import {
  eventCombo,
  formatCombo,
  matchShortcut,
  SHORTCUTS,
} from "../app/lib/shortcuts";

/** Enough of a KeyboardEvent for the matcher, which only reads these five. */
function key(init: {
  alt?: boolean;
  ctrl?: boolean;
  key: string;
  meta?: boolean;
  shift?: boolean;
}): KeyboardEvent {
  return {
    altKey: init.alt ?? false,
    ctrlKey: init.ctrl ?? false,
    key: init.key,
    metaKey: init.meta ?? false,
    shiftKey: init.shift ?? false,
  } as KeyboardEvent;
}

describe("shortcut matching", () => {
  test("mod is Command on a Mac and Control everywhere else", () => {
    expect(eventCombo(key({ key: "k", meta: true }), true)).toBe("mod+k");
    expect(eventCombo(key({ ctrl: true, key: "k" }), false)).toBe("mod+k");
    // The wrong modifier for the platform is not the shortcut.
    expect(eventCombo(key({ ctrl: true, key: "k" }), true)).toBe("k");
  });

  test("shift names itself for letters but not for the keys it produces", () => {
    expect(eventCombo(key({ key: "S", meta: true, shift: true }), true)).toBe(
      "mod+shift+s",
    );
    // `?` is already what shift+/ produces, so naming shift would never match.
    expect(eventCombo(key({ key: "?", shift: true }), true)).toBe("?");
  });

  test("? and / are different bindings, not the same key", () => {
    expect(matchShortcut(key({ key: "?", shift: true }), true)?.id).toBe(
      "help.open",
    );
    expect(matchShortcut(key({ key: "/" }), true)?.id).toBe("table.filter");
  });

  test("a binding with two accepted keys answers to both", () => {
    expect(matchShortcut(key({ key: "Backspace" }), true)?.id).toBe(
      "canvas.delete",
    );
    expect(matchShortcut(key({ key: "Delete" }), true)?.id).toBe(
      "canvas.delete",
    );
  });

  test("a key nothing claims matches nothing", () => {
    expect(matchShortcut(key({ key: "q" }), true)).toBeUndefined();
  });

  test("no two bindings claim the same key", () => {
    const claimed = SHORTCUTS.flatMap((shortcut) => shortcut.combos);

    expect(new Set(claimed).size).toBe(claimed.length);
  });

  test("combos print as keys, with + surviving the split", () => {
    expect(formatCombo("mod+shift+s", true)).toEqual(["⌘", "⇧", "S"]);
    expect(formatCombo("mod+k", false)).toEqual(["Ctrl", "K"]);
    expect(formatCombo("+", true)).toEqual(["+"]);
    expect(formatCombo("backspace", true)).toEqual(["⌫"]);
  });
});
