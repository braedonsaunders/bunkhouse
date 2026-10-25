import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Every location.assign here is a deliberate full-document navigation:
      // sign-in, sign-out and tenant switches must re-render from the server
      // (the root layout holds the resolved session and tenant across client
      // routing), and the rest target route handlers — downloads and OAuth
      // redirects — that a client transition cannot follow.
      '@next/next/no-location-assign-relative-destination': 'off',
    },
  },
  globalIgnores(['.next/**', 'dist/**', 'next-env.d.ts']),
])
