/**
 * The Convex deployment's HTTP-actions origin. Convex serves `httpAction`
 * routes from the `.convex.site` twin of the `.convex.cloud` API URL; the
 * dashboard calls the internal agent-test endpoint there directly (it is
 * deliberately not a gateway path — see packages/convex/agentTestHttp.ts).
 */
export function convexSiteUrl(): string | null {
  const cloudUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!cloudUrl) return null;
  try {
    const url = new URL(cloudUrl);
    if (!url.host.endsWith(".convex.cloud")) return null;
    url.host = `${url.host.slice(0, -".convex.cloud".length)}.convex.site`;

    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}
