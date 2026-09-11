"use client";

import { Header } from "@/app/components/Header";
import { PerfReporter } from "@/app/components/PerfReporter";
import {
  clearOnboardingSecret,
  readOnboardingSecret,
  subscribeOnboardingSecret,
} from "@/app/lib/onboardingSecret";
import { api } from "@broods/convex/_generated/api";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const SYNC_RETRY_MS = 5_000;

// Shown once, on the first login of an account's life. It has no business
// riding along in the layout chunk every other session loads.
const OnboardingDialog = dynamic(() =>
  import("@/app/components/OnboardingDialog").then(
    (mod) => mod.OnboardingDialog,
  ),
);

export default function MainLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element | null {
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

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/auth/sign-in?returnTo=/");
    }
  }, [isLoading, isAuthenticated, router]);

  // A signed-in caller with no user row is a signup whose WorkOS webhook has
  // not landed yet. Create the rows directly; `currentUser` then flips and the
  // routes below proceed as usual. Nothing else re-renders while the row is
  // missing, so a failed attempt schedules its own retry.
  useEffect(() => {
    if (currentUser !== null) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    ensureSynced({}).catch((err: unknown) => {
      console.error("Failed to sync user:", err);
      retry = setTimeout(() => setSyncRetry(syncRetry + 1), SYNC_RETRY_MS);
    });

    return () => clearTimeout(retry);
  }, [currentUser, ensureSynced, syncRetry]);

  useEffect(() => {
    if (profileSynced.current || !isAuthenticated || !user || !currentUser)
      return;
    const name = [user.firstName, user.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    const avatarUrl = user.profilePictureUrl ?? undefined;
    if (!name && !avatarUrl) return;
    profileSynced.current = true;
    syncProfile({ name: name || undefined, avatarUrl: avatarUrl }).catch(() => {
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
      <div className="flex h-screen w-screen flex-col bg-background">
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
        <div className="flex-1 overflow-hidden">{children}</div>
      </div>
    </>
  );
}
