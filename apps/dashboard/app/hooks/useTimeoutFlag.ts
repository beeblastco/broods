import { useEffect, useState } from "react";

// A "Saved" or "Copied" note that hides itself: `value` until `ms` after it changed, then null.
// Pass a fresh value (a new object, or null first) to show the same note again.
export function useTimeoutFlag<T>(value: T | null, ms: number): T | null {
  const [expired, setExpired] = useState<T | null>(null);
  if (expired !== null && expired !== value) setExpired(null);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- the timer that hides the value
  useEffect(() => {
    if (value === null) return;
    const timer = setTimeout(() => setExpired(() => value), ms);

    return () => clearTimeout(timer);
  }, [value, ms]);

  return value === expired ? null : value;
}
