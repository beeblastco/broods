"use client";

/**
 * Links that start their page before they are followed. Intent (hover, focus,
 * a touch) prefetches the whole route and the chunk of the tab it opens, and a
 * plain left press navigates at once instead of on release, which saves the
 * ~100 ms a click spends between the two.
 */
import { FULL_ROUTE_PREFETCH } from "@/app/lib/prefetch";
import { isPlainPress, tabPanelLoader } from "@/app/lib/routeIntent";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useRef } from "react";

export interface RouteIntentHandlers {
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
  onFocus: () => void;
  onMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
  onMouseEnter: () => void;
  onPointerDown: () => void;
}

export function useRouteIntent(): {
  /** Handlers for a link or control that opens `href`; `current` when it is the page already open. */
  handlers: (href: string, current?: boolean) => RouteIntentHandlers;
  /** Starts `href`: its tab's chunk, then the whole route. */
  warm: (href: string) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  // The element whose press already navigated, kept rather than read off the
  // click: the click Base UI fires on a menu item when a press on its trigger
  // is released over it looks like a press, and would go nowhere.
  const pressedRef = useRef<EventTarget | null>(null);

  // The whole route: the default prefetch stops at loading.tsx and expires at
  // once, so a click still fetched the tree, then its chunks, then data. Home
  // only redirects to a project, so nothing is walked from it.
  const warm = useCallback(
    (href: string): void => {
      // A failed warm-up stays quiet; the click's load surfaces it.
      void tabPanelLoader(href)?.().catch((): void => {});
      if (pathname !== "/") router.prefetch(href, FULL_ROUTE_PREFETCH);
    },
    [pathname, router],
  );

  const handlers = useCallback(
    (href: string, current = false): RouteIntentHandlers => {
      const intent = (): void => {
        if (!current) warm(href);
      };

      return {
        onClick: (event) => {
          // The press already navigated. A current link has no press push, so
          // its click still goes there, which resets the page it is on.
          const pressed =
            event.detail > 0 && pressedRef.current === event.currentTarget;
          pressedRef.current = null;
          // A link follows itself on click; anything else is pushed here.
          if (event.currentTarget instanceof HTMLAnchorElement) {
            if (pressed) event.preventDefault();
          } else if (!pressed) {
            router.push(href);
          }
        },
        onFocus: intent,
        onMouseDown: (event) => {
          const push = !current && isPlainPress(event);
          pressedRef.current = push ? event.currentTarget : null;
          if (push) router.push(href);
        },
        onMouseEnter: intent,
        onPointerDown: intent,
      };
    },
    [router, warm],
  );

  return useMemo(() => ({ handlers: handlers, warm: warm }), [handlers, warm]);
}
