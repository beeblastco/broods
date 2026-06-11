import { handleAuth } from "@workos-inc/authkit-nextjs";

const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? "http://localhost:3000/auth/callback";
const url = new URL(redirectUri);

/**
 * Exchanges the WorkOS OAuth code for a session and redirects to the app.
 * @returns Redirect response after successful authentication
 */
export const GET = handleAuth({
    returnPathname: "/",
    baseURL: url.origin
});
