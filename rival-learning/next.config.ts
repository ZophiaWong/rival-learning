import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  experimental: {
    useTypeScriptCli: false,
  },
  poweredByHeader: false,
};

export default nextConfig;
