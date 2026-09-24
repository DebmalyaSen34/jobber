import type { NextConfig } from "next";

const apiProxyTarget = (process.env.API_PROXY_TARGET ?? process.env.NEXT_PUBLIC_API_BASE_URL)?.replace(/\/$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return apiProxyTarget
      ? [{ source: "/api/:path*", destination: `${apiProxyTarget}/api/:path*` }]
      : [];
  },
};

export default nextConfig;
