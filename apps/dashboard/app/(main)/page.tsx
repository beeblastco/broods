"use client";

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import { publishOnboardingSecret } from "@/app/lib/onboardingSecret";
import { api } from "@broods/convex/_generated/api";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export default function HomePage(): React.JSX.Element {
  const router = useRouter();
  const convex = useConvex();
  const getOrCreateOrg = useMutation(api.org.orgs.getOrCreate);
  const getOrCreateDefault = useMutation(api.project.getOrCreateDefault);
  const provision = useAction(api.org.lifecycle.provision);
  const currentUser = useQuery(api.user.getCurrent);
  const started = useRef<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  // Get or create the caller's org, then open the requested or default project.
  // Runs once per attempt; Retry bumps `attempt` to run it again.
  useEffect(() => {
    if (!currentUser || started.current === attempt) return;

    started.current = attempt;
    (async () => {
      try {
        const orgId = await getOrCreateOrg({});

        // On first login (brand-new org with no backend account), auto-provision
        // and hand the one-time secret to the onboarding dialog, then land on the
        // (empty) projects page. Onboarding ends with `broods dev`, which
        // creates the first project.
        const account = await convex.query(api.org.orgs.getActiveAccount, {});
        if (account === null) {
          try {
            const result = await provision({ orgId: orgId });
            publishOnboardingSecret(result.secret);
            router.replace("/projects");

            return;
          } catch (provisionErr) {
            // A production client only sees "Server Error" from an action, so
            // "already provisioned" (another tab won the race) is read from
            // the account, not the message.
            const raced = await convex.query(api.org.orgs.getActiveAccount, {});
            if (raced === null) throw provisionErr;
          }
        }

        // A `broods` deep link (?project=&stage=) jumps straight to that
        // project's architecture view with the same stage selected.
        const params = new URLSearchParams(window.location.search);
        const project = params.get("project");
        if (project) {
          const target = await convex.query(api.project.resolveTarget, {
            project: project,
            stage: params.get("stage") ?? undefined,
          });
          if (target) {
            const next = new URLSearchParams();
            if (target.stageId) {
              next.set("stage", target.stageId);
            }
            const tab = params.get("tab");
            const trace = params.get("trace");
            if (tab) {
              next.set("tab", tab);
            }
            if (trace) {
              next.set("trace", trace);
            }
            const query = next.toString();
            const segment = tab ? "dashboard" : "";
            router.replace(
              `/${target.projectId}${segment ? `/${segment}` : ""}${query ? `?${query}` : ""}`,
            );

            return;
          }
        }

        const projectId = await getOrCreateDefault({});
        router.replace(projectId ? `/${projectId}` : "/projects");
      } catch (err) {
        console.error("Failed to open workspace:", err);
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }, [
    attempt,
    currentUser,
    convex,
    getOrCreateOrg,
    getOrCreateDefault,
    provision,
    router,
  ]);

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
        Setting up your workspace…
      </p>
    </div>
  );
}
