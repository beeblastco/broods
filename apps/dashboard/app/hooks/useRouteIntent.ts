"use client";

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
  handlers: (href: string, alreadyOpen?: boolean) => RouteIntentHandlers;
  warm: (href: string) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  // Not read off the click: Base UI clicks the menu item a trigger press is released over.
  const pressedRef = useRef<EventTarget | null>(null);

  // The default prefetch stops at loading.tsx and expires at once; home only redirects away.
  const warm = useCallback(
    (href: string): void => {
      void tabPanelLoader(href)?.();
      if (pathname !== "/") router.prefetch(href, FULL_ROUTE_PREFETCH);
    },
    [pathname, router],
  );

  const handlers = useCallback(
    (href: string, alreadyOpen = false): RouteIntentHandlers => {
      const intent = (): void => {
        if (!alreadyOpen) warm(href);
      };

      return {
        onClick: (event) => {
          const pressed =
            event.detail > 0 && pressedRef.current === event.currentTarget;
          pressedRef.current = null;
          if (event.currentTarget instanceof HTMLAnchorElement) {
            if (pressed) event.preventDefault();
          } else if (!pressed) {
            router.push(href);
          }
        },
        onFocus: intent,
        onMouseDown: (event) => {
          const push = !alreadyOpen && isPlainPress(event);
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
