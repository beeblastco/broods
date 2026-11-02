"use client";

import { CopilotDock } from "@/app/components/copilot/CopilotDock";
import { CopilotProvider } from "@/app/components/copilot/CopilotProvider";
import { AppSidebar } from "@/app/components/AppSidebar";
import { Header } from "@/app/components/Header";
import { PerfReporter } from "@/app/components/PerfReporter";
import { ShortcutOverlay } from "@/app/components/ShortcutOverlay";
import { ShortcutProvider } from "@/app/components/ShortcutProvider";
import { SidebarInset, SidebarProvider } from "@/app/components/ui/sidebar";
import { TooltipProvider } from "@/app/components/ui/tooltip";
import { useSignedIn } from "@/app/hooks/useSignedIn";
import {
  clearOnboardingSecret,
  readOnboardingSecret,
  subscribeOnboardingSecret,
} from "@/app/lib/onboardingSecret";
import { CONVEX_ID_SHAPE } from "@/app/lib/urlState";
import { api } from "@broods/convex/_generated/api";
import { useSession } from "@/app/lib/session";
import {
  useAction,
  useConvex,
  useConvexAuth,
  useMutation,
  useQuery,
} from "convex/react";
import dynamic from "next/dynamic";
import { analytics } from "@/app/lib/analytics";
import { notFound, useParams, useRouter } from "next/navigation";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

const SYNC_RETRY_MS = 5_000;

// `loading` gives it a Suspense boundary; without one its download suspends the whole shell.
const OnboardingDialog = dynamic(
  () =>
    import("@/app/components/OnboardingDialog").then(
      (mod) => mod.OnboardingDialog,
    ),
  { loading: (): null => null },
);

export function MainShell({
  children,
  defaultSidebarOpen,
}: Readonly<{
  children: React.ReactNode;
  defaultSidebarOpen: boolean;
}>): React.JSX.Element | null {
  // 404 before anything casts the segment to Id<"projects">: a query validator would throw first.
  const { projectId } = useParams<{ projectId?: string }>();
  if (projectId !== undefined && !CONVEX_ID_SHAPE.test(projectId)) notFound();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { user } = useSession();
  const router = useRouter();
  const ensureSynced = useAction(api.user.ensureSynced);
  const syncProfile = useMutation(api.user.syncProfile);
  const signedIn = useSignedIn();
  const currentUser = useQuery(api.user.getCurrent, signedIn ? {} : "skip");
  const convex = useConvex();
  const profileSynced = useRef(false);
  const onboardingSecret = useSyncExternalStore(
    subscribeOnboardingSecret,
    readOnboardingSecret,
    () => null,
  );
  const [syncRetry, setSyncRetry] = useState(0);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- router: sign-in redirect
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      void analytics.then((posthog): void => {
        posthog.reset();
      });
      const returnTo = window.location.pathname + window.location.search;
      router.replace(`/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
    }
  }, [isLoading, isAuthenticated, router]);

  // No row yet: the WorkOS webhook is late. Nothing re-renders meanwhile, so retry on a timer.
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- Convex user row, retry timer
  useEffect(() => {
    if (currentUser !== null) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    ensureSynced({}).catch((err: unknown) => {
      if (cancelled) return;
      console.error("Failed to sync user:", err);
      retry = setTimeout(() => setSyncRetry(syncRetry + 1), SYNC_RETRY_MS);
    });

    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [currentUser, ensureSynced, syncRetry]);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- Convex profile from WorkOS
  useEffect(() => {
    const avatarUrl = user?.profilePictureUrl;
    if (profileSynced.current || !isAuthenticated || !avatarUrl || !currentUser)
      return;
    profileSynced.current = true;
    syncProfile({ avatarUrl: avatarUrl }).catch(() => {
      profileSynced.current = false;
    });
  }, [currentUser, isAuthenticated, user, syncProfile]);

  // PostHog gets a keyed id, never who the user is. A one-off query, so a backend
  // without it (a deploy in flight) costs the id, never the page.
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- PostHog identify and plan
  useEffect(() => {
    if (!currentUser) return;
    void analytics.then((posthog): void => {
      posthog.register({ plan: currentUser.plan });
    });
    convex
      .query(api.user.analyticsId, {})
      .then((id): void => {
        if (id)
          void analytics.then((posthog): void => {
            posthog.identify(id);
          });
      })
      .catch((): void => {});
  }, [convex, currentUser]);

  // Same position in both branches: it survives the auth flip, and LCP lands while loading.
  if (!signedIn) {
    return isLoading ? (
      <>
        <PerfReporter />
        <div className="flex h-screen w-screen items-center justify-center bg-background">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </>
    ) : null;
  }

  return (
    <>
      <PerfReporter />
      <ShortcutProvider>
        <TooltipProvider>
          <Suspense>
            <CopilotProvider>
              <SidebarProvider
                defaultOpen={defaultSidebarOpen}
                className="h-screen flex-col"
              >
                <Header />
                {onboardingSecret && (
                  <OnboardingDialog
                    secret={onboardingSecret}
                    onDone={() => {
                      clearOnboardingSecret();
                      router.push("/projects");
                    }}
                  />
                )}
                <div className="flex min-h-0 flex-1">
                  <AppSidebar />
                  <SidebarInset className="min-w-0 overflow-hidden">
                    {children}
                  </SidebarInset>
                  <CopilotDock />
                </div>
                <ShortcutOverlay />
              </SidebarProvider>
            </CopilotProvider>
          </Suspense>
        </TooltipProvider>
      </ShortcutProvider>
    </>
  );
}
