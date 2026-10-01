import { useSyncExternalStore } from "react";

const MOBILE_QUERY = "(max-width: 767px)";

/** True below the md breakpoint, where the sidebar becomes a sheet. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", onChange);

  return () => mql.removeEventListener("change", onChange);
}
