import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

/**
 * WorkOS AuthKit middleware for session management.
 */
export default authkitMiddleware({
    middlewareAuth: {
        enabled: true,
        unauthenticatedPaths: [
            "/healthz",
            "/login",
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
