"use client";

import { checkBuild, isStaleBuild } from "@/app/lib/buildCheck";
import { FULL_ROUTE_PREFETCH } from "@/app/lib/prefetch";
import {
  isPlainPress,
  isShallowRoute,
  sectionLoader,
  tabPanelLoader,
} from "@/app/lib/routeIntent";
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
  navigate: (href: string) => void;
  warm: (href: string) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  // Not read off the click: Base UI clicks the menu item a trigger press is released over.
  const pressedRef = useRef<EventTarget | null>(null);

  // The default prefetch stops at loading.tsx and expires at once; home only redirects away.
  const warm = useCallback(
    (href: string): void => {
      // A failed warm-up stays quiet; the click's load surfaces it.
      void tabPanelLoader(href)?.().catch((): void => {});
      if (isShallowRoute(pathname, href)) {
        void sectionLoader(href)?.().catch((): void => {});
      } else if (pathname !== "/") router.prefetch(href, FULL_ROUTE_PREFETCH);
    },
    [pathname, router],
  );

  // Next's router follows a pushState, so the route re-renders for the URL with no request.
  // A tab left open across a deploy loads the page instead, which brings the new build.
  const navigate = useCallback(
    (href: string): void => {
      // Read at call time: a caller may hold this across a navigation.
      const { pathname: open, search } = window.location;
      if (!isShallowRoute(open, href)) router.push(href);
      else if (isStaleBuild()) window.location.assign(href);
      else {
        if (href !== `${open}${search}`)
          window.history.pushState(null, "", href);
        checkBuild();
      }
    },
    [router],
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
            // Next's Link would ask the server for a page this route already renders.
            const shallow =
              isPlainPress(event) && isShallowRoute(pathname, href);
            if (pressed || shallow) event.preventDefault();
            if (!pressed && shallow) navigate(href);
          } else if (!pressed) {
            navigate(href);
          }
        },
        onFocus: intent,
        onMouseDown: (event) => {
          const push = !alreadyOpen && isPlainPress(event);
          pressedRef.current = push ? event.currentTarget : null;
          if (push) navigate(href);
        },
        onMouseEnter: intent,
        onPointerDown: intent,
      };
    },
    [navigate, pathname, warm],
  );

  return useMemo(
    () => ({ handlers: handlers, navigate: navigate, warm: warm }),
    [handlers, navigate, warm],
  );
}
