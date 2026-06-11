"use client";

/** Client-side providers for Convex, WorkOS AuthKit, and theming. */
import {
    AuthKitProvider,
    useAuth as useAuthKit,
    useAccessToken,
} from "@workos-inc/authkit-nextjs/components";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ThemeProvider } from "next-themes";
import { useCallback } from "react";
import type { ReactNode } from "react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL as string);

/** Adapts WorkOS AuthKit authentication to the shape required by ConvexProviderWithAuth. */
function useAuthAdapter() {
    const { user, loading: isLoading } = useAuthKit();
    const { getAccessToken, refresh } = useAccessToken();

    const fetchAccessToken = useCallback(
        async ({ forceRefreshToken }: { forceRefreshToken?: boolean } = {}): Promise<string | null> => {
            if (!user) {
                return null;
            }

            try {
                if (forceRefreshToken) {
                    return (await refresh()) ?? null;
                }

                return (await getAccessToken()) ?? null;
            } catch (error) {
                console.error("Failed to get access token:", error);
                return null;
            }
        },
        [user, refresh, getAccessToken],
    );

    return {
        isLoading: isLoading ?? false,
        isAuthenticated: !!user,
        fetchAccessToken: fetchAccessToken,
    };
}

/** Wraps the app with theme, auth, and Convex providers. */
export function ConvexClientProvider({ children }: { children: ReactNode }) {
    return (
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
            <AuthKitProvider>
                <ConvexProviderWithAuth client={convex} useAuth={useAuthAdapter}>
                    {children}
                </ConvexProviderWithAuth>
            </AuthKitProvider>
        </ThemeProvider>
    );
}
