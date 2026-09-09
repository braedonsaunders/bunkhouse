import type { NextConfig } from 'next'

// View Transitions graduated in Next 16.3: React's `ViewTransition` now ships
// in the stable bundle, so `experimental.viewTransition` is gone and setting it
// is a config error. `PageTransition` in the app frame still works unflagged.
const nextConfig: NextConfig = {
  serverExternalPackages: ['@livekit/rtc-node'],
  transpilePackages: ['@bunkhouse/roles', '@bunkhouse/runtime'],
}

export default nextConfig
