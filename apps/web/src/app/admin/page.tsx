import { redirect } from 'next/navigation'

/** Settings is the sidebar settings area itself now — there is no hub in front of it. */
export default function AdminPage() {
  redirect('/admin/settings')
}
