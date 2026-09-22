"use client";

/**
 * One keydown listener for the whole dashboard. Components claim a binding with
 * `useShortcut`, the dispatcher resolves a key event against `SHORTCUTS` and
 * calls whoever claimed it last, so a dialog on top of a page wins without the
 * page knowing the dialog exists.
 */
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
  /** Ids with a handler right now. The `?` overlay dims the rest. */
  activeIds: ReadonlySet<string>;
  isMac: boolean;
  register: (id: ShortcutId, handler: ShortcutHandler) => () => void;
  /**
   * Run a binding without the key. The palette and the copilot go through this
   * so a row does exactly what its shortcut does, down to the same handler.
   */
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
  // The server has no platform, so it renders the Ctrl glyphs and the client
  // swaps them on hydration. The store never changes after that.
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.repeat) return;
      const shortcut = matchShortcut(event, isMac);
      if (!shortcut) return;

      // A bare key is a command only outside text fields, only outside an open
      // dialog, where the page underneath is not what you are driving, and only
      // when it is not the press that activates whatever has focus.
      //
      // The modifiers say whether this is a chord. The combo text cannot: `+`
      // is both the separator and the key `canvas.zoomIn` binds.
      const isChord = event.metaKey || event.ctrlKey || event.altKey;
      if (!isChord && isEditableTarget(event.target)) return;
      if (!isChord && activatesFocusedControl(event)) return;
      if (
        shortcut.scope !== "global" &&
        event.target instanceof HTMLElement &&
        event.target.closest("[role=dialog]")
      ) {
        return;
      }

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

/** Claim a binding while this component is mounted. */
export function useShortcut(id: ShortcutId, handler: ShortcutHandler): void {
  // `register` and nothing else. The context value changes on every
  // registration, so depending on the whole registry would unregister and
  // re-register this binding each time any other one appeared, forever.
  const { register } = useShortcutRegistry();
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(
    () => register(id, (event) => latest.current(event)),
    [id, register],
  );
}

/** Which bindings are live, and how to print them for this platform. */
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

/** The platform cannot change mid-session, so nothing ever notifies. */
function subscribeToPlatform(): () => void {
  return () => {};
}
