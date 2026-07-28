import { redirect } from 'next/navigation'

/** The organization section opens on the people who work here. */
export default function OrganizationIndex() {
  redirect('/organization/people')
}
