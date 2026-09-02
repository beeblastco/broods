/**
 * Short-lived stage session ticket for the browser. Any org member can mint
 * one, so logs, traces and the test chat never need the permanent runtime key
 * in the page. Re-mints before expiry and whenever the stage changes.
 */

import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";

// Re-mint this long before the ticket would expire so a live socket never
// reconnects with a dead credential.
const RENEW_LEAD_MS = 5 * 60 * 1000;

type StageSession = {
  stageId: Id<"stages">;
  token: string;
  expiresAt: number;
};

/**
 * `undefined` while the first mint is in flight, `null` when the stage has no
 * deployment yet, otherwise the ticket to use as the runtime credential.
 */
export function useStageSession(
  projectId: Id<"projects"> | undefined,
  stageId: Id<"stages"> | null,
): string | null | undefined {
  const mint = useMutation(api.agent.deployments.mintStageSession);
  const [session, setSession] = useState<StageSession | null | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!projectId || !stageId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const renew = async (): Promise<void> => {
      try {
        const minted = await mint({ projectId: projectId, stageId: stageId });
        if (cancelled) return;
        if (!minted) {
          setSession(null);

          return;
        }
        setSession({
          stageId: stageId,
          token: minted.token,
          expiresAt: minted.expiresAt,
        });
        timer = setTimeout(
          () => void renew(),
          Math.max(minted.expiresAt - Date.now() - RENEW_LEAD_MS, 1000),
        );
      } catch {
        if (!cancelled) setSession(null);
      }
    };
    void renew();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [mint, projectId, stageId]);

  if (!projectId || !stageId) return null;
  if (session === undefined) return undefined;

  return session && session.stageId === stageId ? session.token : undefined;
}
