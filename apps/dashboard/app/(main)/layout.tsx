"use client";

/** Protected layout that redirects unauthenticated users to /login. */
import { Header } from "@/app/components/Header";
import { OnboardingSecretBanner } from "@/app/components/OnboardingSecretBanner";
import {
    clearOnboardingSecret,
    readOnboardingSecret,
    subscribeOnboardingSecret,
} from "@/app/lib/onboardingSecret";
import { api } from "@broods/convex/_generated/api";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export default function MainLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const { isLoading, isAuthenticated } = useConvexAuth();
    const { user } = useAuth();
    const router = useRouter();
    const syncProfile = useMutation(api.user.syncProfile);
    const currentUser = useQuery(api.user.getCurrent, isAuthenticated ? {} : "skip");
    const profileSynced = useRef(false);
    const [onboardingSecret, setOnboardingSecret] = useState<string | null>(null);

    // Surface the one-time account secret produced by first-login auto-provision,
    // even after the home route redirects to a project.
    useEffect(() => {
        const sync = () => setOnboardingSecret(readOnboardingSecret());
        sync();

        return subscribeOnboardingSecret(sync);
    }, []);

    useEffect(() => {
        if (!isLoading && !isAuthenticated) {
            router.replace("/auth/sign-in?returnTo=/");
        }
    }, [isLoading, isAuthenticated, router]);

    useEffect(() => {
        if (profileSynced.current || !isAuthenticated || !user || !currentUser) return;
        const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
        const avatarUrl = user.profilePictureUrl ?? undefined;
        if (!name && !avatarUrl) return;
        profileSynced.current = true;
        syncProfile({ name: name || undefined, avatarUrl: avatarUrl }).catch(() => {
            profileSynced.current = false;
        });
    }, [currentUser, isAuthenticated, user, syncProfile]);

    if (isLoading) {
        return (
            <div className="flex h-screen w-screen items-center justify-center bg-background">
                <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    return (
        <div className="flex h-screen w-screen flex-col bg-background">
            <Header />
            {onboardingSecret && (
                <OnboardingSecretBanner
                    secret={onboardingSecret}
                    onDismiss={clearOnboardingSecret}
                    className="mt-3"
                />
            )}
            <div className="flex-1 overflow-hidden">{children}</div>
        </div>
    );
}
