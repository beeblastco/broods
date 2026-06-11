import { authkitProxy } from "@workos-inc/authkit-nextjs";

const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? "http://localhost:3000/auth/callback";

/**
 * WorkOS AuthKit middleware for session management.
 */
export default authkitProxy({
    redirectUri: redirectUri,
    middlewareAuth: {
        enabled: true,
        unauthenticatedPaths: [
            "/healthz",
            "/auth/callback",
            "/auth/sign-in",
        ],
    },
});

/**
 * Configure middleware to run on all routes except static assets.
 */
export const config = {
    matcher: [
        "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
        "/(api|trpc)(.*)",
    ],
};
