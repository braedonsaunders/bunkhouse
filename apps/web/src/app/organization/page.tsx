import { redirect } from 'next/navigation'

/** The organization opens on the agents — People and the chart sit on the page's switcher. */
export default function OrganizationIndex() {
  redirect('/organization/agents')
}
