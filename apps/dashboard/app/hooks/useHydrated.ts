import { useSyncExternalStore } from "react";

/**
 * False in the server HTML, true once React owns the page. Rendered as
 * `data-hydrated`, a spec waits on it so its first interaction lands on a
 * listener, not on static markup.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

function subscribeNever(): () => void {
  return () => {};
}
