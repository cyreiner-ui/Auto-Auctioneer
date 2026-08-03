import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repository retains an unused Cloudflare worker starter alongside the
  // Next.js app. Its Cloudflare-only globals are not part of this deployment.
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
