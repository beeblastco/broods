import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ["radix-ui", "@xyflow/react", "lucide-react"],
  },
};

export default nextConfig;
