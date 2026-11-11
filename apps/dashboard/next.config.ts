import type { NextConfig } from "next";

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
const assetOrigin = process.env.DASHBOARD_ASSET_ORIGIN || undefined;
const assetSource = assetOrigin ? ` ${new URL(assetOrigin).origin}` : "";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://*.posthog.com${posthogScriptSource}${assetSource}${isDev ? " 'unsafe-eval'" : ""}`,
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

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  assetPrefix: assetOrigin,
  // CDN chunk errors keep their stack, not "Script error."; the CDN must then send
  // Access-Control-Allow-Origin on every chunk, or the page loads unstyled.
  crossOrigin: "anonymous",
  // esbuild ships platform binaries: bundling it into /api/mcp/bundle crashes Turbopack.
  serverExternalPackages: ["esbuild"],
  experimental: {
    optimizePackageImports: ["@base-ui/react", "@xyflow/react", "lucide-react"],
  },
  headers: async function () {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy,
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            // View state (search text, ids) rides in the URL.
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
