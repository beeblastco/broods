export const NONCE_HEADER = "x-nonce";

const isDev = process.env.NODE_ENV === "development";
// `https:` and `wss:` cover hosted backends; a plain-http one is allowed by exact origin.
const httpBackendSources = [
  process.env.NEXT_PUBLIC_CONVEX_URL,
  process.env.NEXT_PUBLIC_BROODS_BASE_URL,
  process.env.NEXT_PUBLIC_POSTHOG_HOST,
].flatMap((url): string[] => {
  if (!url) return [];
  const { host, protocol } = new URL(url);

  return protocol === "http:" ? [`http://${host}`, `ws://${host}`] : [];
});
// posthog-js loads its lazy scripts from its host, which may be a reverse proxy.
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
const posthogScriptSource =
  posthogHost && URL.canParse(posthogHost)
    ? ` ${new URL(posthogHost).origin}`
    : "";
// The stage's CloudFront copy of /_next/static; unset, the app serves its own chunks.
// Build time only: next.config `env` inlines it into the proxy.
export const assetOrigin = process.env.DASHBOARD_ASSET_ORIGIN || undefined;
const assetSource = assetOrigin ? ` ${new URL(assetOrigin).origin}` : "";

// The proxy passes a fresh nonce per request; hosts after 'strict-dynamic' serve only
// browsers without it. With no nonce (paths the proxy skips) inline scripts run.
export function contentSecurityPolicy(nonce?: string): string {
  const scriptSource = nonce
    ? `'nonce-${nonce}' 'strict-dynamic'`
    : "'unsafe-inline'";

  return [
    "default-src 'self'",
    `script-src 'self' ${scriptSource} https://*.posthog.com${posthogScriptSource}${assetSource}${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline'${assetSource}`,
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    ["connect-src 'self' https: wss:", ...httpBackendSources].join(" "),
    "worker-src 'self' blob:",
    "frame-src 'self' https://checkout.stripe.com https://js.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
