import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ['@tenkacloud/shared'],
  },
  output: 'standalone',
};

export default nextConfig;
