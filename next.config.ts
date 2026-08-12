import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repository retains an unused Cloudflare worker starter alongside the
  // Next.js app. Its Cloudflare-only globals are not part of this deployment.
  typescript: {
    ignoreBuildErrors: true,
  },
  // Headless Chromium (Gixen browser automation) ships a native binary that
  // must not be webpack-bundled, and must be explicitly traced into each
  // route's deployed function bundle or Vercel silently drops it.
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium"],
  outputFileTracingIncludes: {
    "/api/finder/tick": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/finder/items/gixen": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/finder/run": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default nextConfig;
