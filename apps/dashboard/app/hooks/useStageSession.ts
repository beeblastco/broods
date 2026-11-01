import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";

const RENEW_LEAD_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;

type StageSession = {
  stageId: Id<"stages">;
  token: string;
  expiresAt: number;
};

// Undefined while the first mint is in flight, null while the stage has no deployment.
export function useStageSession(
  projectId: Id<"projects"> | undefined,
  stageId: Id<"stages"> | null,
): string | null | undefined {
  const mint = useMutation(api.agent.deployments.mintStageSession);
  const [session, setSession] = useState<StageSession | null | undefined>(
    undefined,
  );

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- ticket renewal timer
  useEffect(() => {
    if (!projectId || !stageId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delayMs: number): void => {
      timer = setTimeout(() => void renew(), delayMs);
    };
    const renew = async (): Promise<void> => {
      let minted: { token: string; expiresAt: number } | null = null;
      try {
        minted = await mint({ projectId: projectId, stageId: stageId });
      } catch {
        minted = null;
      }
      if (cancelled) return;
      if (!minted) {
        setSession(null);
        schedule(RETRY_MS);

        return;
      }
      setSession({
        stageId: stageId,
        token: minted.token,
        expiresAt: minted.expiresAt,
      });
      schedule(Math.max(minted.expiresAt - Date.now() - RENEW_LEAD_MS, 1000));
    };
    void renew();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [mint, projectId, stageId]);

  if (!projectId || !stageId || session === null) return null;
  if (session === undefined || session.stageId !== stageId) return undefined;

  return session.token;
}
