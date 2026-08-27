"use client";

/**
 * "Check everything" (ticket 23): one button that runs
 * agentHealthPublic.check — every green light is a real call made now —
 * and renders each result in plain words with the action that fixes it
 * (ticket 12's action-button pattern: open a tab or the env-vars screen).
 */

import { Button } from "@/app/components/ui/button";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { toErrorMessage } from "@/app/lib/errors";
import { useAction } from "convex/react";
import { CheckCircle2, Loader2, Stethoscope, XCircle } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";

export interface HealthCheckEntry {
  name: "model" | "skill" | "connector" | "channel" | "workspace";
  target: string;
  ok: boolean;
  message: string;
  fix?: {
    label: string;
    kind:
      | "open-env-vars"
      | "open-details"
      | "open-connectors"
      | "open-skills"
      | "open-context";
  };
}

const TAB_BY_FIX: Record<string, string> = {
  "open-details": "details",
  "open-connectors": "connectors",
  "open-skills": "skills",
  "open-context": "context",
};

export function AgentHealthCheck({
  agentConfigId,
  onOpenTab,
  onResults,
}: {
  agentConfigId: Id<"agentConfigs">;
  /** Switches the side panel to another tab (fix-links). */
  onOpenTab?: (tab: string) => void;
  /** Lifts the latest results so the chat's error cards can quote them. */
  onResults?: (checks: HealthCheckEntry[]) => void;
}): React.JSX.Element {
  const runCheck = useAction(api.agentHealthPublic.check);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<HealthCheckEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();

  const handleFix = useCallback(
    (kind: string) => {
      if (kind === "open-env-vars") {
        const next = new URLSearchParams(searchParams.toString());
        next.set("tab", "variables");
        router.push(`/${params.projectId}/settings?${next.toString()}`);

        return;
      }
      const tab = TAB_BY_FIX[kind];
      if (tab) onOpenTab?.(tab);
    },
    [onOpenTab, params.projectId, router, searchParams],
  );

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await runCheck({ configId: agentConfigId });
      setChecks(result.checks);
      onResults?.(result.checks);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [agentConfigId, onResults, runCheck]);

  const failing = (checks ?? []).filter((check) => !check.ok);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
        Health
      </span>
      <div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Stethoscope className="size-3.5" />
          )}
          Check everything
        </Button>
      </div>
      {error && (
        <p className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {error}
        </p>
      )}
      {checks !== null && !error && (
        <div className="mt-1 flex flex-col gap-1">
          {checks.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Nothing to check yet — this agent has no model, skills,
              connectors, channels or folders configured.
            </p>
          )}
          {failing.length === 0 && checks.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-foreground">
              <CheckCircle2 className="size-3.5 text-green-600" />
              All {checks.length} checks passed — every light below came from a
              real call just now.
            </p>
          )}
          {checks.map((check) => (
            <div
              key={`${check.name}:${check.target}`}
              className={`flex items-start gap-2 rounded-md border px-2 py-1.5 ${
                check.ok
                  ? "border-border/60 bg-muted/20"
                  : "border-red-500/30 bg-red-500/5"
              }`}
            >
              {check.ok ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-green-600" />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-500" />
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-xs font-medium text-foreground">
                  {check.name} · {check.target}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {check.message}
                </span>
                {!check.ok && check.fix && (
                  <button
                    type="button"
                    className="mt-0.5 cursor-pointer self-start text-[11px] font-medium text-foreground underline underline-offset-2"
                    onClick={() => handleFix(check.fix!.kind)}
                  >
                    {check.fix.label}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
