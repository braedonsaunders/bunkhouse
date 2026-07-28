import { Spinner } from '@appkit/ui'
import { SplashHold } from '@/components/brand-splash'

// Root route-loading fallback. This is the whole app's fallback, so it runs on
// every internal navigation as well as the first load — it must not be the
// brand splash. It renders inside the frame, so the nav and chrome stay put
// and only the page area waits.
//
// SplashHold still asks the cold-start overlay to stay up while the first page
// streams; once that overlay has retired it is a no-op, so navigations get the
// quiet spinner and nothing else.
export default function Loading() {
  return (
    <>
      <SplashHold />
      <div className="flex h-full min-h-64 w-full items-center justify-center">
        <Spinner />
      </div>
    </>
  )
}
