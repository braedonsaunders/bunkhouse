import { redirect } from 'next/navigation'

/** Hiring became Roles + onboarding; old links land there. */
export default function HirePage() {
  redirect('/roles')
}
