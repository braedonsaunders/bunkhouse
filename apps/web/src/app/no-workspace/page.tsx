import { redirect } from 'next/navigation'
import { requireUser } from '../../lib/auth'
import { getTenantSelection } from '../../lib/tenant'

export const dynamic = 'force-dynamic'

/**
 * Landing for a signed-in account with no active workspace membership.
 * Deliberately calm and professional — this is an access state, not an error.
 * If the user actually has a workspace (e.g. they were just added), send them
 * home rather than stranding them here.
 */
export default async function NoWorkspacePage() {
  const user = await requireUser()
  const { current } = await getTenantSelection(user)
  if (current) redirect('/')
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">No workspace yet</h1>
        <p className="mt-3 text-sm leading-6 text-fg-muted">
          You are signed in as <span className="font-medium text-fg">{user.email}</span>, but this account is not a
          member of any workspace on this installation.
        </p>
        <p className="mt-2 text-sm leading-6 text-fg-muted">
          Ask an administrator to add you to a workspace. Once that happens, sign back in or refresh this page and
          you will land in it automatically.
        </p>
      </div>
    </div>
  )
}
