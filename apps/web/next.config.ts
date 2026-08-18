import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: { viewTransition: true },
  serverExternalPackages: ['@livekit/rtc-node'],
  transpilePackages: ['@bunkhouse/roles', '@bunkhouse/runtime'],
}

export default nextConfig
