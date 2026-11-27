import { useEffect, type RefObject } from "react";

// Writes each committed `value` into `ref`, for callbacks that read it and must stay stable.
// The caller owns the ref, so the hooks linter still knows it never changes.
export function useLatestRef<T>(ref: RefObject<T>, value: T): void {
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- copies the commit into a ref
  useEffect(() => {
    ref.current = value;
  }, [ref, value]);
}
