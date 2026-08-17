import { Spinner } from '@braedonsaunders/appkit-ui'

// Root route-loading fallback. This is the whole app's fallback, so it runs on
// every internal navigation as well as the first load — it must not be the
// brand splash. It renders inside the frame, so the nav and chrome stay put
// and only the page area waits.
//
// The cold-start splash owns its own bounded entrance. This fallback may remain
// mounted by Next while a streamed route settles, so it must never hold the
// document-level overlay open or it can make an otherwise-ready page inert.
export default function Loading() {
  return (
    <div className="flex h-full min-h-64 w-full items-center justify-center">
      <Spinner />
    </div>
  )
}
