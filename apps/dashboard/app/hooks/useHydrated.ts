import { useSyncExternalStore } from "react";

// Rendered as `data-hydrated`: a spec waits on it so its first click lands on a listener.
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

// A store that never changes, for useSyncExternalStore.
export function subscribeNever(): () => void {
  return () => {};
}
