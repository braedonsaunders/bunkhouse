import { createAppkitAuthClient } from '@braedonsaunders/appkit-auth/client'

// Browser-side Better Auth client (sign-in, sign-out, session). Base URL is
// same-origin, so no configuration is needed here.
export const authClient = createAppkitAuthClient()
