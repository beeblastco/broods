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
import {
  clearOnboardingSecret,
  readOnboardingSecret,
  subscribeOnboardingSecret,
} from "@/app/lib/onboardingSecret";
import { api } from "@broods/convex/_generated/api";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import dynamic from "next/dynamic";
import { notFound, useParams, useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

const SYNC_RETRY_MS = 5_000;

// A Convex id is 31 to 37 characters of lowercase Crockford base32 (no i, l, o, u).
const CONVEX_ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{31,37}$/;

// Shown once, on the first login of an account's life. It has no business
// riding along in the layout chunk every other session loads. `loading` is
// what buys it a Suspense boundary of its own; without one its download
// suspends the whole signed-in tree, header included.
const OnboardingDialog = dynamic(
  () =>
    import("@/app/components/OnboardingDialog").then(
      (mod) => mod.OnboardingDialog,
    ),
  { loading: (): null => null },
);

/** The signed-in shell: auth gates, header, sidebar, page and copilot dock. */
export function MainShell({
  children,
  defaultSidebarOpen,
}: Readonly<{
  children: React.ReactNode;
  defaultSidebarOpen: boolean;
}>): React.JSX.Element | null {
  // A segment that cannot be a project id is a 404 before anything queries
  // with it: the header, copilot and page all cast it to `Id<"projects">`, and
  // the first query validator to reject it would win over a notFound() thrown
  // further down.
  const { projectId } = useParams<{ projectId?: string }>();
  if (projectId !== undefined && !CONVEX_ID_SHAPE.test(projectId)) notFound();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const router = useRouter();
  const ensureSynced = useAction(api.user.ensureSynced);
  const syncProfile = useMutation(api.user.syncProfile);
  const currentUser = useQuery(
    api.user.getCurrent,
    isAuthenticated ? {} : "skip",
  );
  const profileSynced = useRef(false);
  const [onboardingSecret, setOnboardingSecret] = useState<string | null>(null);
  const [syncRetry, setSyncRetry] = useState(0);

  // Surface the one-time account secret produced by first-login auto-provision
  // in the onboarding dialog, even after the home route navigates away.
  useEffect(() => {
    const sync = (): void => setOnboardingSecret(readOnboardingSecret());
    sync();

    return subscribeOnboardingSecret(sync);
  }, []);

  // An expired session signs in again and lands back where it was; the
  // sign-in route validates `returnTo`.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const returnTo = window.location.pathname + window.location.search;
      router.replace(`/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
    }
  }, [isLoading, isAuthenticated, router]);

  // A signed-in caller with no user row is a signup whose WorkOS webhook has
  // not landed yet. Create the rows directly; `currentUser` then flips and the
  // routes below proceed as usual. Nothing else re-renders while the row is
  // missing, so a failed attempt schedules its own retry.
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

  useEffect(() => {
    const avatarUrl = user?.profilePictureUrl;
    if (profileSynced.current || !isAuthenticated || !avatarUrl || !currentUser)
      return;
    profileSynced.current = true;
    syncProfile({ avatarUrl: avatarUrl }).catch(() => {
      profileSynced.current = false;
    });
  }, [currentUser, isAuthenticated, user, syncProfile]);

  // The reporter is the first child of both fragments, one tree position, so
  // it survives the auth flip instead of registering every observer twice.
  // Mounted before the gates: LCP usually lands while this is still loading.
  if (isLoading) {
    return (
      <>
        <PerfReporter />
        <div className="flex h-screen w-screen items-center justify-center bg-background">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </>
    );
  }

  if (!isAuthenticated) {
    return null;
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
                {/* The dock is a column beside the page, not a sheet over it: what
                    it is about to change has to stay on screen. */}
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
