import { useState } from "react";

/**
 * True from the first render in which `flag` was true. Mounts a lazy
 * component on first use and keeps it mounted, so its close animation and
 * state survive without loading its chunk before it is wanted.
 */
export function useEverTrue(flag: boolean): boolean {
  const [seen, setSeen] = useState(flag);
  if (flag && !seen) setSeen(true);

  return seen || flag;
}
