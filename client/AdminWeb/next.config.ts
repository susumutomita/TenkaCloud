import type { NextConfig } from 'next';
import { CONTROL_PLANE_BASE_PATH } from './lib/base-path';

const nextConfig: NextConfig = {
  // Static export — pure S3+CloudFront 配信のため。API routes / server actions は使えない。
  output: 'export',
  // BucketDeployment が `client/AdminWeb/dist` を参照する。
  distDir: 'dist',
  basePath: CONTROL_PLANE_BASE_PATH || undefined,
  // Static export で生成される dist/<route>/index.html を CloudFront errorResponse 404→/index.html
  // で SPA fallback させる構成のため、trailing slash は付けない (path-without-slash で 404→fallback)。
  trailingSlash: false,
  // Next.js Image Optimization は Lambda 不要のため無効化 (export では使えない)。
  images: { unoptimized: true },
};

export default nextConfig;
