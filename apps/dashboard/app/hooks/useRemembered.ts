import { useCallback, useState } from "react";

/**
 * State that survives a reload, for a page's sort and filter. Lives in
 * localStorage under `key`; a blocked or missing store falls back to plain
 * state so the page still works.
 */
export function useRemembered<T>(
  key: string,
  initial: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => read(key) ?? initial);
  const remember = useCallback(
    (next: T): void => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private mode or a full store: the page keeps the value in memory.
      }
    },
    [key],
  );

  return [value, remember];
}

function read<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);

    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}
