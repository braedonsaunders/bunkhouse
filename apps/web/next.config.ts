import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: { viewTransition: true },
  transpilePackages: ['@bunkhouse/roles', '@bunkhouse/runtime'],
}

export default nextConfig
