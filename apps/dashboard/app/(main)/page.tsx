"use client";

/** Home route that ensures the caller has an org, then opens their default project (auto-created on first login). */
import { publishOnboardingSecret } from "@/app/lib/onboardingSecret";
import { api } from "@broods/convex/_generated/api";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** Routes authenticated users to their most recent project, creating one on first login. */
export default function HomePage() {
    const router = useRouter();
    const convex = useConvex();
    const getOrCreateOrg = useMutation(api.org.getOrCreate);
    const getOrCreateDefault = useMutation(api.project.getOrCreateDefault);
    const provision = useAction(api.orgLifecycle.provision);
    const currentUser = useQuery(api.user.getCurrent);
    const bootstrapped = useRef(false);
    const [error, setError] = useState<string | null>(null);

    // Ensure the caller has an org, then open the requested or default project.
    useEffect(() => {
        if (!currentUser || bootstrapped.current) return;

        bootstrapped.current = true;
        (async () => {
            try {
                const orgId = await getOrCreateOrg({});

                // On first login (brand-new org with no backend account), auto-provision
                // and hand the one-time secret to the onboarding dialog, then land on the
                // (empty) projects page — onboarding ends with `bunx broods dev`, which
                // creates the first project. `provision` throws if an account already
                // exists, which we treat as already-provisioned.
                const account = await convex.query(api.org.getActiveAccount, {});
                if (account === null) {
                    try {
                        const result = await provision({ orgId: orgId });
                        publishOnboardingSecret(result.secret);
                        router.replace("/projects");

                        return;
                    } catch (provisionErr) {
                        console.warn("Auto-provision skipped:", provisionErr);
                    }
                }

                // A `broods` deep link (?project=&env=) jumps straight to that
                // project's architecture view with the same environment selected.
                const params = new URLSearchParams(window.location.search);
                const project = params.get("project");
                if (project) {
                    const target = await convex.query(api.project.resolveTarget, {
                        project: project,
                        environment: params.get("env") ?? undefined,
                    });
                    if (target) {
                        const next = new URLSearchParams();
                        if (target.environmentId) {
                            next.set("env", target.environmentId);
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
                        router.replace(`/${target.projectId}${segment ? `/${segment}` : ""}${query ? `?${query}` : ""}`);
                        return;
                    }
                }

                const projectId = await getOrCreateDefault({});
                router.replace(projectId ? `/${projectId}` : "/projects");
            } catch (err) {
                console.error("Failed to open workspace:", err);
                setError(err instanceof Error ? err.message : "Failed to open workspace. Please refresh.");
                bootstrapped.current = false;
            }
        })();
    }, [currentUser, convex, getOrCreateOrg, getOrCreateDefault, provision, router]);

    return (
        <div className="flex h-full w-full items-center justify-center bg-background">
            {error ? (
                <div className="flex flex-col items-center gap-3 text-center">
                    <p className="text-sm text-destructive">{error}</p>
                    <button
                        className="text-xs text-muted-foreground underline cursor-pointer"
                        onClick={() => {
                            bootstrapped.current = false;
                            setError(null);
                        }}
                    >
                        Retry
                    </button>
                </div>
            ) : (
                <div className="flex flex-col items-center gap-3">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
                    <p className="text-sm text-muted-foreground">Setting up your workspace…</p>
                </div>
            )}
        </div>
    );
}
