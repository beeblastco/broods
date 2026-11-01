"use client";

import {
  activatesFocusedControl,
  isEditableTarget,
  matchShortcut,
  type ShortcutId,
} from "@/app/lib/shortcuts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

type ShortcutHandler = (event: KeyboardEvent) => void;

interface ShortcutRegistry {
  activeIds: ReadonlySet<string>;
  isMac: boolean;
  register: (id: ShortcutId, handler: ShortcutHandler) => () => void;
  trigger: (id: ShortcutId) => void;
}

const ShortcutContext = createContext<ShortcutRegistry | null>(null);

export function ShortcutProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const handlers = useRef(new Map<string, ShortcutHandler[]>());
  const [activeIds, setActiveIds] = useState<ReadonlySet<string>>(new Set());
  const isMac = useSyncExternalStore(
    subscribeToPlatform,
    readIsMac,
    () => false,
  );

  const register = useCallback(
    (id: ShortcutId, handler: ShortcutHandler): (() => void) => {
      const stack = handlers.current.get(id) ?? [];
      handlers.current.set(id, [...stack, handler]);
      setActiveIds((prev) => new Set(prev).add(id));

      return () => {
        const remaining = (handlers.current.get(id) ?? []).filter(
          (entry) => entry !== handler,
        );
        handlers.current.set(id, remaining);
        if (remaining.length === 0) {
          setActiveIds((prev) => {
            const next = new Set(prev);
            next.delete(id);

            return next;
          });
        }
      };
    },
    [],
  );

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- window keydown listener
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.repeat) return;
      const shortcut = matchShortcut(event, isMac);
      if (!shortcut) return;

      // Chord by modifiers, not combo text: `+` is both the separator and zoomIn's key.
      const isChord = event.metaKey || event.ctrlKey || event.altKey;
      if (event.defaultPrevented || event.isComposing) return;
      if (
        !isChord &&
        event.key !== "Escape" &&
        isEditableTarget(event.target)
      ) {
        return;
      }
      if (!isChord && activatesFocusedControl(event)) return;
      // Inside a popup, page keys belong to the popup: Escape closes it, not the panel.
      if (
        shortcut.scope !== "global" &&
        event.target instanceof HTMLElement &&
        event.target.closest("[role=dialog], [role=menu], [role=listbox]")
      ) {
        return;
      }

      // The last claim wins, so a dialog on top beats the page under it.
      const stack = handlers.current.get(shortcut.id);
      const handler = stack?.at(-1);
      if (!handler) return;

      event.preventDefault();
      event.stopPropagation();
      handler(event);
    }

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMac]);

  const trigger = useCallback((id: ShortcutId): void => {
    handlers.current.get(id)?.at(-1)?.(new KeyboardEvent("keydown"));
  }, []);

  const value = useMemo(
    () => ({
      activeIds: activeIds,
      isMac: isMac,
      register: register,
      trigger: trigger,
    }),
    [activeIds, isMac, register, trigger],
  );

  return (
    <ShortcutContext.Provider value={value}>
      {children}
    </ShortcutContext.Provider>
  );
}

export function useShortcut(id: ShortcutId, handler: ShortcutHandler): void {
  // Depend on `register` alone: the registry value changes on every registration.
  const { register } = useShortcutRegistry();
  const latest = useRef(handler);
  latest.current = handler;

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- window keydown dispatcher
  useEffect(
    () => register(id, (event) => latest.current(event)),
    [id, register],
  );
}

export function useShortcutRegistry(): ShortcutRegistry {
  const registry = useContext(ShortcutContext);
  if (!registry) {
    throw new Error("useShortcut must be used inside ShortcutProvider");
  }

  return registry;
}

function readIsMac(): boolean {
  return /mac/i.test(navigator.platform || navigator.userAgent);
}

function subscribeToPlatform(): () => void {
  return () => {};
}
