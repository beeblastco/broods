import { useEffect } from "react";

// Starts the open tab's chunk download alongside its query, instead of after the query lands.
export function useWarmPanel(load: (() => Promise<unknown>) | undefined): void {
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- downloads the panel's chunk
  useEffect(() => {
    // A failed warm-up stays quiet; the panel's own load surfaces it.
    void load?.().catch((): void => {});
  }, [load]);
}
