import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
// `https:` and `wss:` cover hosted backends; a plain-http Convex or gateway
// (the local stack, a self-hosted LAN) is allowed by its exact origin.
const httpBackendSources = [
  process.env.NEXT_PUBLIC_CONVEX_URL,
  process.env.NEXT_PUBLIC_BROODS_BASE_URL,
].flatMap((url): string[] => {
  if (!url) return [];
  const { host, protocol } = new URL(url);

  return protocol === "http:" ? [`http://${host}`, `ws://${host}`] : [];
});
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https:",
  "font-src 'self' data:",
  ["connect-src 'self' https: wss:", ...httpBackendSources].join(" "),
  "frame-src 'self' https://checkout.stripe.com https://js.stripe.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // esbuild ships platform binaries; bundling it into the /api/mcp/bundle
  // route crashes Turbopack. Load it from node_modules at runtime instead.
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
            key: "Referrer-Policy",
            value: "origin-when-cross-origin",
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
