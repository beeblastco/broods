"use client";

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import { publishOnboardingSecret } from "@/app/lib/onboardingSecret";
import { api } from "@broods/convex/_generated/api";
import { useAction, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// The params a deep link may hand the canvas (`node`) or the project dashboard.
const VIEW_PARAMS = [
  "tab",
  "trace",
  "q",
  "range",
  "from",
  "to",
  "models",
  "bin",
  "node",
] as const;

export default function HomePage(): React.JSX.Element {
  const router = useRouter();
  const openHome = useMutation(api.project.openHome);
  const provision = useAction(api.org.lifecycle.provision);
  const currentUser = useQuery(api.user.getCurrent);
  const started = useRef<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  // One `openHome` call gets or creates the org and picks the project; only a
  // brand-new org needs the provision step. Runs once per attempt; Retry bumps
  // `attempt` to run it again.
  useEffect(() => {
    if (!currentUser || started.current === attempt) return;

    started.current = attempt;
    void (async () => {
      try {
        // A `broods` deep link (?project=&stage=) opens that project's
        // architecture view with the same stage selected.
        const params = new URLSearchParams(window.location.search);
        const deepLink = {
          project: params.get("project") ?? undefined,
          stage: params.get("stage") ?? undefined,
        };
        let home = await openHome(deepLink);
        if (home.needsProvision) {
          // First login: hand the one-time secret to the onboarding dialog and
          // land on the (empty) projects page. Onboarding ends with
          // `broods dev`, which creates the first project.
          try {
            const result = await provision({ orgId: home.orgId });
            publishOnboardingSecret(result.secret);
            router.replace("/projects");

            return;
          } catch (provisionErr) {
            // Another tab may have provisioned first; only a still-missing
            // account is a failure.
            home = await openHome(deepLink);
            if (home.needsProvision) throw provisionErr;
          }
        }
        if (!home.projectId) {
          router.replace("/projects");

          return;
        }

        // Only the view params the canvas and project dashboard read carry
        // over, so nothing else in the link lands in the project URL; the page
        // parses each one and drops what it rejects.
        const next = new URLSearchParams();
        for (const key of VIEW_PARAMS) {
          const value = params.get(key);
          if (value !== null) next.set(key, value);
        }
        if (home.stageId) next.set("stage", home.stageId);
        const query = next.toString();
        router.replace(
          `/${home.projectId}${next.has("tab") ? "/dashboard" : ""}${query ? `?${query}` : ""}`,
        );
      } catch (err) {
        console.error("Failed to open workspace:", err);
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }, [attempt, currentUser, openHome, provision, router]);

  if (error) {
    return (
      <StatusPage title="Workspace setup failed" error={error}>
        <Button
          className="cursor-pointer"
          onClick={() => {
            setError(null);
            setAttempt(attempt + 1);
          }}
        >
          Retry
        </Button>
      </StatusPage>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <p className="text-sm text-muted-foreground">
        {currentUser && !currentUser.activeOrgId
          ? "Setting up your workspace…"
          : "Opening your project…"}
      </p>
    </div>
  );
}
