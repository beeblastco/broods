import type { NextConfig } from "next";
import {
  assetOrigin,
  contentSecurityPolicy,
} from "./app/lib/contentSecurityPolicy";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  assetPrefix: assetOrigin,
  env: {
    DASHBOARD_ASSET_ORIGIN: assetOrigin ?? "",
    DASHBOARD_BUILD_ID: crypto.randomUUID(),
  },
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
        // The complement of the proxy matcher; the proxy sets a nonce policy everywhere else.
        source: "/:path(_next/.*|assets/.*|favicon\\.ico.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy(),
          },
        ],
      },
      {
        source: "/:path*",
        headers: [
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
